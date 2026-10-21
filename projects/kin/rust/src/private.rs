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
//! Kinds 100–199 are reserved for private records. The journal (#496), the
//! "Just for me" list (#510) and reminders and settings that follow a member
//! (#520) add their own kinds here and their own sections to KPRV. Until
//! then the log has one placeholder kind, `PRIVATE_NOTE_SET` (100): a short
//! private note by ID, enough to prove the log end to end. It is unreleased
//! and the first of those stories may replace it.
//!
//! Replay rules (replay never fails on a decoded private event, beyond the
//! checks every log makes):
//! - Every event in one private log has the same author: the log's member.
//!   An event from anyone else is invalid; the service and the member key
//!   already keep other members out, so this is a consistency check, not the
//!   access control.
//! - A note set to text replaces the note; set to empty text it is removed.
//!   The latest event in replay order wins.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, DeviceId, EventEnvelope, EventKind, PrivateRecordId};
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
/// KPRV sections (`encode_private`).
pub const SECTION_NOTES: u16 = 1;

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
        _ => Err(KinError::InvalidEvent),
    }
}

/// Decodes a private payload strictly. A code in the private range that this
/// engine does not know is unsupported (a later release added it).
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
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
    let size = 32 + 8 + notes.len();
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
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out.extend_from_slice(&SECTION_NOTES.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out.extend_from_slice(&(notes.len() as u32).to_le_bytes());
    out.extend_from_slice(&notes);
    Ok(out)
}
