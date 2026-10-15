use std::collections::{BTreeMap, BTreeSet};

use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, AreaId, AttachmentId, AttachmentParentKind, EventEnvelope, EventId,
    EventKind, HandoffId, HouseholdId, HouseholdMode, ItemClassification, ItemId, NoteId,
    PinTargetKind, PulseValue, ReferenceFieldId, ReferenceRecordId, ResponsibilityTargetKind,
    RoutineId, StepId, TalkId,
};
use crate::recurrence::{Cadence, CivilDate};

mod summary;
pub use summary::{summarize, summarize_validated, SummaryInput};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutineState {
    pub routine_id: RoutineId,
    pub text: String,
    pub created_by: ActorId,
    pub created_at: i64,
    pub created_on: CivilDate,
    pub cadence: Cadence,
    pub archived: bool,
    pub occurrence_key: Option<CivilDate>,
    pub completed: bool,
    /// When the next new occurrence opens. Derived from the cadence and the
    /// projection date; `None` once archived or past the calendar range.
    pub next_start: Option<CivilDate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemStatus {
    Active,
    Completed,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ItemState {
    pub item_id: ItemId,
    pub text: String,
    pub created_by: ActorId,
    pub created_at: i64,
    pub last_changed_at: i64,
    pub classification: ItemClassification,
    pub planning_date: Option<CivilDate>,
    pub status: ItemStatus,
    pub area_id: Option<AreaId>,
    pub steps: Vec<ItemStepState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ItemStepState {
    pub step_id: StepId,
    pub text: String,
    pub completed: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AreaState {
    pub area_id: AreaId,
    pub name: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaybookState {
    pub playbook_id: crate::event::PlaybookId,
    pub title: String,
    pub entries: Vec<String>,
    pub archived: bool,
}

pub const MAX_PLAYBOOKS: usize = 32;
pub const MAX_PLAYBOOK_ENTRIES: usize = 16;
pub const MAX_PLAYBOOK_TITLE_BYTES: usize = 128;
pub const MAX_PLAYBOOK_ENTRY_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceFieldState {
    pub field_id: ReferenceFieldId,
    pub label: String,
    pub value: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceRecordState {
    pub record_id: ReferenceRecordId,
    pub title: String,
    pub area_id: Option<AreaId>,
    pub fields: Vec<ReferenceFieldState>,
    pub archived: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaintenanceEventState {
    pub maintenance_id: crate::event::MaintenanceEventId,
    pub record_id: ReferenceRecordId,
    pub performed_on: CivilDate,
    pub summary: String,
    pub next_on: Option<CivilDate>,
    pub routine_id: Option<RoutineId>,
    pub archived: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentState {
    pub attachment_id: AttachmentId,
    pub parent_kind: AttachmentParentKind,
    pub parent_id: [u8; 16],
    pub removed: bool,
}
pub const MAX_ATTACHMENTS: usize = 256;
/// Logical time is interoperable with JavaScript safe integers. A single event
/// may advance the observed clock by at most this amount, so one authenticated
/// event cannot strand future local writes near the protocol ceiling.
pub const MAX_LOGICAL_TIME: u64 = 9_007_199_254_740_991;
pub const MAX_LOGICAL_TIME_ADVANCE: u64 = 1_000_000;
pub const MAX_MAINTENANCE_EVENTS_PER_RECORD: usize = 64;
pub const MAX_MAINTENANCE_SUMMARY_BYTES: usize = 240;
pub fn normalize_maintenance_summary(summary: &str) -> Result<String, KinError> {
    let summary = summary.trim();
    if summary.is_empty()
        || summary.len() > MAX_MAINTENANCE_SUMMARY_BYTES
        || summary.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(summary.to_owned())
}
pub const MAX_REFERENCE_RECORDS: usize = 128;
pub const MAX_REFERENCE_FIELDS: usize = 16;
pub const MAX_REFERENCE_TITLE_BYTES: usize = 128;
pub const MAX_REFERENCE_LABEL_BYTES: usize = 64;
pub const MAX_REFERENCE_VALUE_BYTES: usize = 1024;
pub const MAX_REFERENCE_COMMAND_BYTES: usize = 20
    + MAX_REFERENCE_TITLE_BYTES
    + MAX_REFERENCE_FIELDS * (20 + MAX_REFERENCE_LABEL_BYTES + MAX_REFERENCE_VALUE_BYTES);
pub fn normalize_reference_text(
    title: &str,
    fields: &[(ReferenceFieldId, String, String)],
) -> Result<(String, Vec<ReferenceFieldState>), KinError> {
    let title = title.trim();
    if title.is_empty()
        || title.len() > MAX_REFERENCE_TITLE_BYTES
        || title.chars().any(char::is_control)
        || fields.is_empty()
        || fields.len() > MAX_REFERENCE_FIELDS
    {
        return Err(KinError::InvalidEvent);
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::with_capacity(fields.len());
    for (id, label, value) in fields {
        let label = label.trim();
        if id.0 == [0; 16]
            || !seen.insert(*id)
            || label.is_empty()
            || label.len() > MAX_REFERENCE_LABEL_BYTES
            || label.chars().any(char::is_control)
            || value.len() > MAX_REFERENCE_VALUE_BYTES
            || value
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        {
            return Err(KinError::InvalidEvent);
        }
        normalized.push(ReferenceFieldState {
            field_id: *id,
            label: label.to_owned(),
            value: value.clone(),
        });
    }
    Ok((title.to_owned(), normalized))
}

pub fn normalize_playbook(
    title: &str,
    entries: &[String],
) -> Result<(String, Vec<String>), KinError> {
    let title = title.trim();
    if title.is_empty()
        || title.len() > MAX_PLAYBOOK_TITLE_BYTES
        || title.chars().any(char::is_control)
        || entries.is_empty()
        || entries.len() > MAX_PLAYBOOK_ENTRIES
    {
        return Err(KinError::InvalidEvent);
    }
    let mut normalized = Vec::with_capacity(entries.len());
    for entry in entries {
        let text = entry.trim();
        if text.is_empty()
            || text.len() > MAX_PLAYBOOK_ENTRY_BYTES
            || text.chars().any(char::is_control)
        {
            return Err(KinError::InvalidEvent);
        }
        normalized.push(text.to_owned());
    }
    Ok((title.to_owned(), normalized))
}

pub const MAX_AREAS: usize = 32;
pub const MAX_AREA_NAME_BYTES: usize = 96;
pub const MAX_AREA_NAME_CHARS: usize = 48;
pub const MAX_NOTES: usize = 128;
pub const MAX_NOTE_TITLE_BYTES: usize = 256;
pub const MAX_NOTE_TITLE_CHARS: usize = 80;
pub const MAX_NOTE_BODY_BYTES: usize = 4 * 1024;
pub const MAX_STEPS_PER_ITEM: usize = 16;
pub const MAX_STEP_TEXT_BYTES: usize = 256;
pub const MAX_STEP_TEXT_CHARS: usize = 80;

pub fn normalize_step_text(text: &str) -> Result<String, KinError> {
    let normalized = text.trim();
    if normalized.is_empty()
        || normalized.len() > MAX_STEP_TEXT_BYTES
        || normalized.chars().count() > MAX_STEP_TEXT_CHARS
        || normalized.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(normalized.to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoteStatus {
    Active,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteState {
    pub note_id: NoteId,
    pub title: String,
    pub body: String,
    pub area_id: Option<AreaId>,
    pub created_by: ActorId,
    pub created_at: i64,
    pub updated_by: ActorId,
    pub updated_at: i64,
    pub status: NoteStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PinState {
    pub target_kind: PinTargetKind,
    pub target_id: [u8; 16],
}

pub const MAX_PINS: usize = 10;

pub fn normalize_note(title: &str, body: &str) -> Result<(String, String), KinError> {
    let title = title.trim();
    if title.is_empty()
        || title.len() > MAX_NOTE_TITLE_BYTES
        || title.chars().count() > MAX_NOTE_TITLE_CHARS
        || title.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    if body.len() > MAX_NOTE_BODY_BYTES
        || body
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
    {
        return Err(KinError::InvalidEvent);
    }
    Ok((title.to_owned(), body.to_owned()))
}

pub fn normalize_area_name(name: &str) -> Result<String, KinError> {
    let normalized = name.trim();
    if normalized.is_empty()
        || normalized.len() > MAX_AREA_NAME_BYTES
        || normalized.chars().count() > MAX_AREA_NAME_CHARS
        || normalized.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(normalized.to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HandoffStatus {
    Unacknowledged,
    Acknowledged,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoffState {
    pub handoff_id: HandoffId,
    pub text: String,
    pub created_by: ActorId,
    pub created_at: i64,
    pub status: HandoffStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TalkStatus {
    Open,
    Resolved,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TalkState {
    pub talk_id: TalkId,
    pub text: String,
    pub created_by: ActorId,
    pub created_at: i64,
    pub status: TalkStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PulseStatus {
    Active,
    Expired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PulseState {
    pub actor_id: ActorId,
    pub value: PulseValue,
    pub set_at: i64,
    pub expires_at: i64,
    pub status: PulseStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HouseholdState {
    pub household_id: Option<HouseholdId>,
    pub mode: HouseholdMode,
    pub items: Vec<ItemState>,
    pub handoffs: Vec<HandoffState>,
    pub talks: Vec<TalkState>,
    pub pulses: Vec<PulseState>,
    pub routines: Vec<RoutineState>,
    pub areas: Vec<AreaState>,
    pub notes: Vec<NoteState>,
    pub pins: Vec<PinState>,
    pub playbooks: Vec<PlaybookState>,
    pub reference_records: Vec<ReferenceRecordState>,
    pub maintenance_events: Vec<MaintenanceEventState>,
    pub attachments: Vec<AttachmentState>,
    pub responsibilities: Vec<ResponsibilityState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResponsibilityState {
    pub target_kind: ResponsibilityTargetKind,
    pub target_id: [u8; 16],
    pub member_id: Option<ActorId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SummaryKind {
    ItemAdded = 1,
    ItemCompleted = 2,
    ItemReopened = 3,
    ItemArchived = 4,
    HandoffAdded = 5,
    HandoffAcknowledged = 6,
    HandoffArchived = 7,
    TalkAdded = 8,
    TalkResolved = 9,
    TalkReopened = 10,
    TalkArchived = 11,
    RoutineCreated = 12,
    RoutineOccurrenceCompleted = 13,
    RoutineOccurrenceReopened = 14,
    RoutineArchived = 15,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SummaryEntityKind {
    Item = 1,
    Handoff = 2,
    Talk = 3,
    Routine = 4,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SummaryEntry {
    pub event_id: EventId,
    pub kind: SummaryKind,
    pub entity_kind: SummaryEntityKind,
    pub text: String,
    pub classification: Option<ItemClassification>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatchUpSummary {
    pub entries: Vec<SummaryEntry>,
    pub total_count: u32,
    pub through_event_id: Option<EventId>,
}

pub const MAX_SUMMARY_ENTRIES: usize = 8;

/// Deterministic household replay at an explicit `as_of` instant and civil
/// date. Reduction uses an owned copy sorted by `(logical_time, device_id,
/// event_id)`; callers keep arrival order for catch-up boundaries. The
/// reducers live in replay/ (`Replay`); history.rs keeps a checkpoint so it
/// can apply only newer events.
pub fn rebuild(
    events: &[EventEnvelope],
    as_of: i64,
    civil_date: CivilDate,
) -> Result<HouseholdState, KinError> {
    if !valid_timestamp(as_of) {
        return Err(KinError::MalformedProtocol);
    }
    let mut ordered_events = events.to_vec();
    ordered_events.sort_by_key(|event| (event.logical_time, event.device_id, event.event_id));
    let mut replay = crate::replay::Replay::new();
    replay.note_archives(&ordered_events);
    for event in &ordered_events {
        replay.apply(event)?;
    }
    replay.finalize(as_of, civil_date)
}

#[cfg(test)]
mod tests;
