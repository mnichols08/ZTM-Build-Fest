use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::Mutex;

use crate::error::KinError;
use crate::sections::SectionRevisions;
use crate::wire::{ERROR_PROTOCOL_VERSION, MAX_PROTOCOL_BYTES};

struct AbiState {
    allocations: BTreeMap<u32, Box<[u8]>>,
    result: Vec<u8>,
    error: Vec<u8>,
    /// Where `result` holds a projection, when it does.
    projection: Option<Range<usize>>,
    /// The last emitted projection's buffer and range, kept after a later
    /// non-projection call replaced `result`, so revisions stay comparable.
    previous: Vec<u8>,
    previous_projection: Option<Range<usize>>,
    revisions: SectionRevisions,
}

impl AbiState {
    const fn new() -> Self {
        Self {
            allocations: BTreeMap::new(),
            result: Vec::new(),
            error: Vec::new(),
            projection: None,
            previous: Vec::new(),
            previous_projection: None,
            revisions: SectionRevisions::new(),
        }
    }

    /// Clears the published buffers before an operation. A projection in
    /// `result` moves aside (no copy) as the basis for the next revisions.
    fn begin(&mut self) {
        if let Some(range) = self.projection.take() {
            self.previous = std::mem::take(&mut self.result);
            self.previous_projection = Some(range);
        } else {
            self.result.clear();
        }
        self.error.clear();
    }

    /// Stamps the section revisions of a projection inside `result`, then
    /// drops the previous projection: `result` is the basis from now on.
    fn stamp(&mut self, result: &mut [u8], range: Range<usize>) -> Result<(), KinError> {
        let previous = self
            .previous_projection
            .as_ref()
            .and_then(|range| self.previous.get(range.clone()));
        self.revisions.stamp(&mut result[range.clone()], previous)?;
        self.previous = Vec::new();
        self.previous_projection = None;
        self.projection = Some(range);
        Ok(())
    }
}

impl AbiState {
    /// Drops every retained buffer (`kin_clear`). Revision counters survive:
    /// a later projection must never reuse a revision a host may still hold,
    /// and without a previous projection every section counts as changed.
    fn clear(&mut self) {
        self.allocations.clear();
        self.result = Vec::new();
        self.error = Vec::new();
        self.projection = None;
        self.previous = Vec::new();
        self.previous_projection = None;
    }

    /// Publishes an operation's outcome as the result or error buffer and
    /// returns the status code.
    fn publish(&mut self, outcome: Result<Vec<u8>, KinError>, locate: Option<Locate>) -> i32 {
        let outcome = outcome.and_then(|mut result| {
            if let Some(range) = locate.and_then(|locate| locate(&result)) {
                self.stamp(&mut result, range)?;
            }
            Ok(result)
        });
        match outcome {
            Ok(result) => {
                self.result = result;
                0
            }
            Err(error) => {
                self.error = error_buffer(error);
                error.code()
            }
        }
    }
}

/// Locates the projection inside an operation's result.
type Locate = fn(&[u8]) -> Option<Range<usize>>;

/// A KINS result is the projection itself.
fn whole(result: &[u8]) -> Option<Range<usize>> {
    Some(0..result.len())
}

/// KCMT header: "KCMT", version u16, reserved u16, then the event, metadata
/// and projection lengths as u32 at 8, 12 and 16 (command.rs execute_request).
const KCMT_HEADER_BYTES: usize = 20;

/// A KCMT result ends with the projection, after the event and metadata.
/// None (the result is then left unstamped, revision 0) if the lengths do not
/// add up, which a well-formed result never does.
fn command_projection(result: &[u8]) -> Option<Range<usize>> {
    let length = |at: usize| -> Option<usize> {
        Some(u32::from_le_bytes(result.get(at..at + 4)?.try_into().ok()?) as usize)
    };
    let start = KCMT_HEADER_BYTES
        .checked_add(length(8)?)?
        .checked_add(length(12)?)?;
    (start.checked_add(length(16)?)? == result.len()).then_some(start..result.len())
}

// One per WASM instance: each loaded engine is its own instance with its own
// statics, which is why revisions are "per engine instance". WASM here is
// single-threaded; the Mutex is what Rust requires for a mutable static and
// what keeps native test builds, which do run threads, sound.
static ABI_STATE: Mutex<AbiState> = Mutex::new(AbiState::new());

fn lock_state() -> std::sync::MutexGuard<'static, AbiState> {
    ABI_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn request_length_is_supported(length: u32) -> bool {
    usize::try_from(length).is_ok_and(|size| size <= MAX_PROTOCOL_BYTES)
}

fn error_buffer(error: KinError) -> Vec<u8> {
    let message = error.message().as_bytes();
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(12 + message.len()).is_err() {
        return bytes;
    }
    bytes.extend_from_slice(b"KERR");
    bytes.extend_from_slice(&ERROR_PROTOCOL_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(error.code() as u16).to_le_bytes());
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message);
    bytes
}

fn active_buffer_pointer(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        0
    } else {
        bytes.as_ptr() as usize as u32
    }
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_alloc(length: u32) -> u32 {
    if length == 0 || !request_length_is_supported(length) {
        return 0;
    }
    let Ok(capacity) = usize::try_from(length) else {
        return 0;
    };
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(capacity).is_err() {
        return 0;
    }
    bytes.resize(capacity, 0);
    let mut allocation = bytes.into_boxed_slice();
    let pointer = allocation.as_mut_ptr() as usize as u32;
    if pointer == 0 {
        return 0;
    }
    lock_state().allocations.insert(pointer, allocation);
    pointer
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_free(pointer: u32, length: u32) -> i32 {
    // kin_alloc returns 0 for a failed or empty allocation; freeing that
    // "nothing" succeeds, so a host can free unconditionally.
    if pointer == 0 && length == 0 {
        return 0;
    }
    let mut state = lock_state();
    let Some(allocation) = state.allocations.get(&pointer) else {
        return KinError::InvalidAbi.code();
    };
    if allocation.len() != length as usize {
        return KinError::InvalidAbi.code();
    }
    state.allocations.remove(&pointer);
    0
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_apply_events(pointer: u32, length: u32) -> i32 {
    operate_projection(pointer, length, crate::core::replay, whole)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_event_metadata(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::codec::encode_metadata)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_event_metadata_batch(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::codec::encode_metadata_batch)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_encode_command(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::command::encode_command)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_execute_command(pointer: u32, length: u32) -> i32 {
    operate_projection(
        pointer,
        length,
        crate::command::execute_request,
        command_projection,
    )
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_encode_archive(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::build_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_decode_archive(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::validate_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_archive_header(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::header_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_archive_layout(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::layout_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_plan_import(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::plan_import)
}

fn operate(pointer: u32, length: u32, operation: fn(&[u8]) -> Result<Vec<u8>, KinError>) -> i32 {
    run(pointer, length, operation, None)
}

/// An operation whose result carries a projection: its section revisions are
/// stamped against the last projection this instance emitted.
fn operate_projection(
    pointer: u32,
    length: u32,
    operation: fn(&[u8]) -> Result<Vec<u8>, KinError>,
    locate: Locate,
) -> i32 {
    run(pointer, length, operation, Some(locate))
}

fn run(
    pointer: u32,
    length: u32,
    operation: fn(&[u8]) -> Result<Vec<u8>, KinError>,
    locate: Option<Locate>,
) -> i32 {
    // Keep inputs and published buffers stable against concurrent free, clear, or calls.
    let mut state = lock_state();
    state.begin();
    let outcome = if !request_length_is_supported(length) {
        Err(KinError::SizeLimit)
    } else if length == 0 {
        Err(KinError::MalformedProtocol)
    } else {
        state
            .allocations
            .get(&pointer)
            .map_or(Err(KinError::InvalidAbi), |input| {
                if input.len() != length as usize {
                    Err(KinError::InvalidAbi)
                } else {
                    operation(input)
                }
            })
    };
    state.publish(outcome, locate)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_result_ptr() -> u32 {
    active_buffer_pointer(&lock_state().result)
}

/// Drops retained buffers on host lock, without claiming memory zeroization.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_clear() {
    lock_state().clear();
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_result_len() -> u32 {
    lock_state().result.len() as u32
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_error_ptr() -> u32 {
    active_buffer_pointer(&lock_state().error)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_error_len() -> u32 {
    lock_state().error.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{item_record, kine, text_record, TEST_DATE};

    /// One projection call through the ABI state, returning its revisions.
    fn emit(state: &mut AbiState, records: &[Vec<u8>]) -> Vec<u32> {
        state.begin();
        let outcome = crate::core::replay(&kine(records, 0, TEST_DATE, None));
        assert_eq!(state.publish(outcome, Some(whole)), 0);
        revisions(&state.result)
    }

    fn revisions(projection: &[u8]) -> Vec<u32> {
        (0..14)
            .map(|index| {
                let at = 96 + index * 8;
                u32::from_le_bytes(projection[at..at + 4].try_into().unwrap())
            })
            .collect()
    }

    #[test]
    fn revisions_advance_only_for_changed_sections_across_calls() {
        let mut state = AbiState::new();
        let item = item_record(1, 0x11, b"Milk", 1);
        let first = emit(&mut state, std::slice::from_ref(&item));
        assert_eq!(
            first,
            vec![1; 14],
            "a fresh instance stamps every section 1"
        );
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), first);

        // A Handoff changes Handoffs and the catch-up summary, nothing else.
        let handoff = text_record(5, 2, 0x12, b"Bins are out");
        let second = emit(&mut state, &[item.clone(), handoff.clone()]);
        let mut expected = first.clone();
        expected[1] = 2;
        expected[13] = 2;
        assert_eq!(second, expected);

        // A non-projection call in between keeps the comparison basis.
        state.begin();
        assert_ne!(state.publish(Err(KinError::InvalidEvent), Some(whole)), 0);
        state.begin();
        assert_eq!(state.publish(Ok(b"metadata".to_vec()), None), 0);
        assert_eq!(emit(&mut state, &[item.clone(), handoff]), expected);

        // Returning to earlier content is still a change: counters never go back.
        let third = emit(&mut state, std::slice::from_ref(&item));
        expected[1] = 3;
        expected[13] = 3;
        assert_eq!(third, expected);
    }

    #[test]
    fn a_lost_basis_advances_every_section_and_never_reuses_a_revision() {
        let mut state = AbiState::new();
        let item = item_record(1, 0x11, b"Milk", 1);
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), vec![1; 14]);
        // kin_clear drops buffers but keeps counters.
        state.clear();
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), vec![2; 14]);
    }

    #[test]
    fn command_results_locate_their_trailing_projection() {
        let mut result = b"KCMT\x01\0\0\0".to_vec();
        for length in [3u32, 2, 4] {
            result.extend_from_slice(&length.to_le_bytes());
        }
        result.extend_from_slice(&[0xee; 9]);
        assert_eq!(command_projection(&result), Some(25..29));
        result.push(0);
        assert_eq!(
            command_projection(&result),
            None,
            "lengths must cover the result"
        );
        assert_eq!(command_projection(&result[..10]), None);
    }

    #[test]
    fn request_size_is_bounded_before_pointer_dereference() {
        assert!(request_length_is_supported(MAX_PROTOCOL_BYTES as u32));
        assert!(!request_length_is_supported(MAX_PROTOCOL_BYTES as u32 + 1));
    }
}
