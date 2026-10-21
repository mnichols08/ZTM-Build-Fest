//! A member's private log (#489, ADR 0019): records only that member's own
//! devices can read, sealed under the member key (MK) instead of a household
//! key.
//!
//! Private events live in their own log (history.rs `Log::Private`), apart
//! from the household history, chat and the fridge: they never enter
//! household replay, the KINS projection or a household request, and every
//! other log refuses them. An engine instance holds the private log of the
//! one member who is unlocked on this device.
//!
//! Kinds 100–199 are reserved for private records, in a share per story:
//!
//! | Kinds | Story | Module |
//! |---|---|---|
//! | 100 | the placeholder `PRIVATE_NOTE_SET` (#489) | here |
//! | 101–109 | the journal (#496) | journal.rs |
//! | 110–119 | "Just for me" (#510) | to come |
//! | 120–139 | reminders and settings that follow a member (#520) | to come |
//!
//! Kind 100 stays reserved and decodable: it proved the log end to end
//! before the journal, and no surface writes it (`execute` refuses it). Each
//! story adds its own KPRV section, numbered after the first kind of its
//! share (the journal's is section 101), so stories built side by side never
//! pick the same section code.
//!
//! Replay rules (replay never fails on a decoded private event, beyond the
//! checks every log makes):
//! - Every event in one private log has the same author: the log's member.
//!   An event from anyone else is invalid; the service and the member key
//!   already keep other members out, so this is a consistency check, not the
//!   access control.
//! - A note set to text replaces the note; set to empty text it is removed.
//!   The latest event in replay order wins.
//! - Journal events replay as journal.rs describes.
//!
//! New private events come from `execute` (`kin_private_execute`): a KCMD
//! intent whose text is the event's exact payload, checked against the
//! replayed private log (its member, the order, the story's own rules), as
//! the fridge's commands are checked against the board log.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, DeviceId, EventEnvelope, EventId, EventKind, HouseholdId,
    PrivateRecordId,
};
use crate::history::{History, Log};
use crate::journal::{JournalState, FIRST_JOURNAL_KIND};
use crate::wire::{read_id, read_u32, MAX_PROTOCOL_BYTES};

/// The first and last kind codes reserved for private records.
pub const FIRST_PRIVATE_KIND: u16 = 100;
pub const LAST_PRIVATE_KIND: u16 = 199;
/// The placeholder private kind (see the module doc).
pub const PRIVATE_NOTE_SET: u16 = 100;
/// Most events one member's private log holds (ADR 0019).
pub const MAX_PRIVATE_EVENT_COUNT: usize = 50_000;
/// Largest private note, in UTF-8 bytes.
pub const MAX_PRIVATE_NOTE_BYTES: usize = 2_048;
/// KPRV sections (`encode_private`): the notes, then each story's own,
/// numbered after the first kind of its share.
pub const SECTION_NOTES: u16 = 1;
pub const SECTION_JOURNAL: u16 = FIRST_JOURNAL_KIND;

/// Whether a kind code is reserved for the private log. Every code in the
/// range belongs to the private log, known or not, so a household log never
/// takes one.
pub const fn is_private_code(code: u16) -> bool {
    code >= FIRST_PRIVATE_KIND && code <= LAST_PRIVATE_KIND
}

/// The canonical payload of a private event.
///
/// `PRIVATE_NOTE_SET`: note ID [16] (never zero), text length u32
/// (0 removes the note, at most `MAX_PRIVATE_NOTE_BYTES`), UTF-8 text.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::PrivateNoteSet { note_id, text } => {
            if note_id.0 == [0; 16] || !valid_note(text) {
                return Err(KinError::MalformedProtocol);
            }
            let mut payload = Vec::with_capacity(20 + text.len());
            payload.extend_from_slice(&note_id.0);
            payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
            payload.extend_from_slice(text.as_bytes());
            Ok(payload)
        }
        EventKind::Journal(event) => crate::journal::encode_payload(event),
        _ => Err(KinError::InvalidEvent),
    }
}

/// Decodes a private payload strictly. A code in the private range that this
/// engine does not know is unsupported (a later release added it).
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    if crate::journal::is_journal_code(code) {
        return crate::journal::decode_payload(code, payload).map(EventKind::Journal);
    }
    match code {
        PRIVATE_NOTE_SET => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let note_id = PrivateRecordId(read_id(payload, 0)?);
            let length = read_u32(payload, 16)? as usize;
            if note_id.0 == [0; 16] || payload.len() != 20 + length {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            if !valid_note(text) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(EventKind::PrivateNoteSet {
                note_id,
                text: text.to_owned(),
            })
        }
        _ => Err(KinError::UnsupportedVersion),
    }
}

/// A note's text: empty (removal) or 1..=MAX_PRIVATE_NOTE_BYTES bytes with
/// no control characters but line breaks. Never trimmed here: what the
/// member wrote is what is kept.
fn valid_note(text: &str) -> bool {
    text.len() <= MAX_PRIVATE_NOTE_BYTES
        && !text
            .chars()
            .any(|character| character.is_control() && character != '\n')
}

/// One private note as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateNote {
    pub text: String,
    /// The logical time and device of the event that set it.
    pub logical_time: u64,
    pub device_id: DeviceId,
}

/// One member's private records as replayed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PrivateState {
    member: Option<ActorId>,
    notes: BTreeMap<PrivateRecordId, PrivateNote>,
    journal: JournalState,
}

impl PrivateState {
    /// The member every event in this log was written by, once there is one.
    pub fn member(&self) -> Option<ActorId> {
        self.member
    }

    /// Notes by ID (ascending).
    pub fn notes(&self) -> impl Iterator<Item = (&PrivateRecordId, &PrivateNote)> {
        self.notes.iter()
    }

    pub fn note(&self, id: &PrivateRecordId) -> Option<&PrivateNote> {
        self.notes.get(id)
    }

    /// The member's journal (journal.rs).
    pub fn journal(&self) -> &JournalState {
        &self.journal
    }
}

/// Replays one private event into the member's state (copy-on-write).
pub fn apply(state: &mut Arc<PrivateState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    if state.member.is_some_and(|member| member != event.actor_id) {
        return Err(KinError::InvalidEvent);
    }
    let state = Arc::make_mut(state);
    state.member = Some(event.actor_id);
    match &event.kind {
        EventKind::PrivateNoteSet { note_id, text } => {
            if text.is_empty() {
                state.notes.remove(note_id);
            } else {
                state.notes.insert(
                    *note_id,
                    PrivateNote {
                        text: text.clone(),
                        logical_time: event.logical_time,
                        device_id: event.device_id,
                    },
                );
            }
            Ok(())
        }
        EventKind::Journal(journal) => {
            state.journal.apply(event, journal);
            Ok(())
        }
        _ => Err(KinError::InvalidEvent),
    }
}

/// KPRV v1, the member's private projection (`kin_private_state`):
///
/// "KPRV", version u16 = 1, reserved u16 = 0; member ID [16] (zero while the
/// log is empty); record count u32 (events in the log); section count u16,
/// reserved u16; then each section: code u16, reserved u16, byte length u32,
/// bytes. Sections appear in ascending code order, each at most once. A
/// reader skips a section whose code it does not know, so the stories that
/// add private records extend KPRV by adding sections, never by changing
/// one.
///
/// Section 1, notes (the placeholder kind): note count u32, then each note
/// in ascending ID order: ID [16], logical time u64, device ID [16], text
/// length u32, text.
///
/// Section 101, the journal: journal.rs `encode_section`.
pub fn encode_private(state: &PrivateState, record_count: usize) -> Result<Vec<u8>, KinError> {
    let mut notes = Vec::new();
    notes.extend_from_slice(&(state.notes.len() as u32).to_le_bytes());
    for (id, note) in &state.notes {
        notes.extend_from_slice(&id.0);
        notes.extend_from_slice(&note.logical_time.to_le_bytes());
        notes.extend_from_slice(&note.device_id.0);
        notes.extend_from_slice(&(note.text.len() as u32).to_le_bytes());
        notes.extend_from_slice(note.text.as_bytes());
    }
    let journal = crate::journal::encode_section(&state.journal);
    let sections: [(u16, &[u8]); 2] = [(SECTION_NOTES, &notes), (SECTION_JOURNAL, &journal)];
    let size = 32
        + sections
            .iter()
            .map(|(_, bytes)| 8 + bytes.len())
            .sum::<usize>();
    if size > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let record_count = u32::try_from(record_count).map_err(|_| KinError::SizeLimit)?;
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    out.extend_from_slice(b"KPRV");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out.extend_from_slice(&state.member.map_or([0; 16], |member| member.0));
    out.extend_from_slice(&record_count.to_le_bytes());
    out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    for (code, bytes) in sections {
        out.extend_from_slice(&code.to_le_bytes());
        out.extend_from_slice(&[0; 2]);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

/// The most text a private KCMD may carry (a journal entry with ten photos
/// is about 21.6 KB).
pub const MAX_PRIVATE_COMMAND_TEXT: usize = 64 * 1024;

/// A KCMD for a private event (ABI.md): the 128-byte header (event ID,
/// household, member, device, timestamp, logical time; the entity ID, date,
/// option and expiry fields zero) and the event's exact payload as its text.
fn decode_private_command(bytes: &[u8]) -> Result<EventEnvelope, KinError> {
    if bytes.len() < 128 || bytes.len() > 128 + MAX_PRIVATE_COMMAND_TEXT || &bytes[..4] != b"KCMD" {
        return Err(KinError::MalformedProtocol);
    }
    if bytes[4..6] != 1u16.to_le_bytes() {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] || bytes[10..12] != [0; 2] || bytes[92..124] != [0; 32] {
        return Err(KinError::MalformedProtocol);
    }
    let code = u16::from_le_bytes([bytes[8], bytes[9]]);
    if bytes.len() != 128 + read_u32(bytes, 124)? as usize {
        return Err(KinError::MalformedProtocol);
    }
    // Only a story's own kinds are written; the placeholder note never is.
    if !is_private_code(code) || code == PRIVATE_NOTE_SET {
        return Err(KinError::UnsupportedVersion);
    }
    let kind = decode_payload(code, &bytes[128..])?;
    let mut time = [0u8; 8];
    time.copy_from_slice(&bytes[76..84]);
    let timestamp = i64::from_le_bytes(time);
    time.copy_from_slice(&bytes[84..92]);
    let logical_time = u64::from_le_bytes(time);
    Ok(EventEnvelope {
        event_id: EventId(read_id(bytes, 12)?),
        household_id: HouseholdId(read_id(bytes, 28)?),
        actor_id: ActorId(read_id(bytes, 44)?),
        device_id: DeviceId(read_id(bytes, 60)?),
        timestamp,
        logical_time,
        event_version: 1,
        kind,
        canonical_bytes: Vec::new(),
    })
}

/// Whether a new private event may be written over the member's replayed
/// records: its author is the log's member, and its story's rules allow it.
fn check_command(state: &PrivateState, event: &EventEnvelope) -> Result<(), KinError> {
    if state.member.is_some_and(|member| member != event.actor_id) {
        return Err(KinError::InvalidEvent);
    }
    match &event.kind {
        EventKind::Journal(journal) => state.journal.check_command(journal),
        _ => Err(KinError::InvalidEvent),
    }
}

/// A private command against the private log (`kin_private_execute`): u32
/// intent length, the KCMD intent, then the record-less KINE context.
/// Publishes KCMT: the canonical event and its KMET metadata, with an empty
/// projection. The log is not changed; the host appends the event once it is
/// sealed and stored.
pub fn execute(bytes: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let length = read_u32(bytes, 0)? as usize;
    let end = 4usize
        .checked_add(length)
        .ok_or(KinError::MalformedProtocol)?;
    let event = decode_private_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let context =
        crate::request::decode_context(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    if history.log() != Log::Private
        || history.len() >= history.limit()
        || [
            event.event_id.0,
            event.household_id.0,
            event.actor_id.0,
            event.device_id.0,
        ]
        .contains(&[0; 16])
        || !valid_timestamp(event.timestamp)
        || event.logical_time == 0
        || event.logical_time > crate::state::MAX_LOGICAL_TIME
        || context
            .target_household_id
            .is_some_and(|household| household != event.household_id)
    {
        return Err(KinError::InvalidEvent);
    }
    let empty = history.is_empty();
    let replay = history.replay(&context)?;
    // Strictly after every event held, in the same household, never reusing
    // an event ID.
    if !empty
        && (replay.household_id() != Some(event.household_id)
            || replay.last_logical_time() >= event.logical_time
            || replay.contains_event(event.event_id))
    {
        return Err(KinError::InvalidEvent);
    }
    check_command(replay.private(), &event)?;
    let canonical = crate::codec::encode_event(&event)?;
    let metadata = crate::codec::encode_metadata(&canonical)?;
    let mut out = Vec::with_capacity(20 + canonical.len() + metadata.len());
    out.extend_from_slice(b"KCMT");
    out.extend_from_slice(&[1, 0, 0, 0]);
    out.extend_from_slice(&(canonical.len() as u32).to_le_bytes());
    out.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&canonical);
    out.extend_from_slice(&metadata);
    Ok(out)
}
