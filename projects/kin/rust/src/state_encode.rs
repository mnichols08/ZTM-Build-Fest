//! Protocol-24 KINS projection encoding.
//!
//! Header (96 bytes): "KINS", version 24, reserved 0, then u32 counts for
//! Items, Handoffs, Talks and Pulses; summary count and total; through-present
//! flag (u8 + 3 reserved) and the through event ID; then u32 counts for
//! Routines, Areas, Notes and Steps; the household mode (u8 + 3 reserved);
//! and u32 counts for Pins, Playbooks, Reference Records, Maintenance events,
//! Attachments and Responsibilities.
//!
//! Body, in order: Item, Handoff, Talk and Pulse records; one Area ID per Item;
//! Routines; Areas; Notes; Steps grouped by Item; one planning date per Item;
//! one last-changed timestamp per Item; Pins; Playbooks; Reference Records;
//! Maintenance events; Attachments; Responsibilities; one next-occurrence date
//! per Routine; then the catch-up summary entries. ABI.md has every field.
use crate::error::KinError;
use crate::event::{valid_timestamp, ItemClassification};
use crate::recurrence::CivilDate;
use crate::state::{
    CatchUpSummary, HandoffStatus, HouseholdState, ItemStatus, NoteStatus, PulseStatus,
    SummaryEntityKind, SummaryKind, TalkStatus, MAX_SUMMARY_ENTRIES,
};
use crate::wire::{
    push_u16, push_u32, MAX_EVENT_COUNT, MAX_ITEM_TEXT_BYTES, MAX_MAINTENANCE_EVENTS,
    MAX_PROTOCOL_BYTES, PROTOCOL_VERSION, RESULT_HEADER_BYTES,
};

const PULSE_BYTES: usize = 40;
const SUMMARY_HEADER_BYTES: usize = 24;

/// Appends bounded sections, failing with `SizeLimit` before the result could
/// exceed the 64 MiB protocol bound.
struct Output(Vec<u8>);

impl Output {
    fn reserve(&mut self, additional: usize) -> Result<(), KinError> {
        let total = self
            .0
            .len()
            .checked_add(additional)
            .ok_or(KinError::SizeLimit)?;
        if total > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        self.0
            .try_reserve(additional)
            .map_err(|_| KinError::SizeLimit)
    }

    fn bytes(&mut self, bytes: &[u8]) -> Result<(), KinError> {
        self.reserve(bytes.len())?;
        self.0.extend_from_slice(bytes);
        Ok(())
    }

    fn u8(&mut self, value: u8) -> Result<(), KinError> {
        self.bytes(&[value])
    }

    fn u16(&mut self, value: u16) -> Result<(), KinError> {
        self.reserve(2)?;
        push_u16(&mut self.0, value);
        Ok(())
    }

    fn u32(&mut self, value: u32) -> Result<(), KinError> {
        self.reserve(4)?;
        push_u32(&mut self.0, value);
        Ok(())
    }

    fn count(&mut self, value: usize) -> Result<(), KinError> {
        self.u32(u32::try_from(value).map_err(|_| KinError::SizeLimit)?)
    }

    fn text(&mut self, text: &str) -> Result<(), KinError> {
        self.count(text.len())?;
        self.bytes(text.as_bytes())
    }
}

fn classification_code(classification: ItemClassification) -> u8 {
    match classification {
        ItemClassification::Today => 0,
        ItemClassification::Need => 1,
        ItemClassification::Shopping => 2,
        ItemClassification::Staple => 3,
    }
}

pub fn encode_state(state: &HouseholdState, summary: &CatchUpSummary) -> Result<Vec<u8>, KinError> {
    validate(state, summary)?;
    let step_count = state
        .items
        .iter()
        .map(|item| item.steps.len())
        .sum::<usize>();
    let mut out = Output(Vec::new());
    out.reserve(RESULT_HEADER_BYTES)?;
    out.bytes(b"KINS")?;
    out.u16(PROTOCOL_VERSION)?;
    out.u16(0)?;
    out.count(state.items.len())?;
    out.count(state.handoffs.len())?;
    out.count(state.talks.len())?;
    out.count(state.pulses.len())?;
    out.count(summary.entries.len())?;
    out.u32(summary.total_count)?;
    out.u8(u8::from(summary.through_event_id.is_some()))?;
    out.bytes(&[0; 3])?;
    out.bytes(&summary.through_event_id.map_or([0; 16], |id| id.0))?;
    out.count(state.routines.len())?;
    out.count(state.areas.len())?;
    out.count(state.notes.len())?;
    out.count(step_count)?;
    out.u8(state.mode as u8)?;
    out.bytes(&[0; 3])?;
    out.count(state.pins.len())?;
    out.count(state.playbooks.len())?;
    out.count(state.reference_records.len())?;
    out.count(state.maintenance_events.len())?;
    out.count(state.attachments.len())?;
    out.count(state.responsibilities.len())?;

    for item in &state.items {
        out.bytes(&item.item_id.0)?;
        out.bytes(&item.created_by.0)?;
        out.bytes(&item.created_at.to_le_bytes())?;
        out.u8(classification_code(item.classification))?;
        out.u8(match item.status {
            ItemStatus::Active => 0,
            ItemStatus::Completed => 1,
            ItemStatus::Archived => 2,
        })?;
        out.bytes(&[0; 2])?;
        out.text(&item.text)?;
    }
    for handoff in &state.handoffs {
        out.bytes(&handoff.handoff_id.0)?;
        out.bytes(&handoff.created_by.0)?;
        out.bytes(&handoff.created_at.to_le_bytes())?;
        out.u8(match handoff.status {
            HandoffStatus::Unacknowledged => 0,
            HandoffStatus::Acknowledged => 1,
            HandoffStatus::Archived => 2,
        })?;
        out.bytes(&[0; 3])?;
        out.text(&handoff.text)?;
    }
    for talk in &state.talks {
        out.bytes(&talk.talk_id.0)?;
        out.bytes(&talk.created_by.0)?;
        out.bytes(&talk.created_at.to_le_bytes())?;
        out.u8(match talk.status {
            TalkStatus::Open => 0,
            TalkStatus::Resolved => 1,
            TalkStatus::Archived => 2,
        })?;
        out.bytes(&[0; 3])?;
        out.text(&talk.text)?;
    }
    for pulse in &state.pulses {
        out.reserve(PULSE_BYTES)?;
        out.bytes(&pulse.actor_id.0)?;
        out.bytes(&pulse.set_at.to_le_bytes())?;
        out.bytes(&pulse.expires_at.to_le_bytes())?;
        out.u8(pulse.value as u8)?;
        out.u8(match pulse.status {
            PulseStatus::Active => 0,
            PulseStatus::Expired => 1,
        })?;
        out.bytes(&[0; 6])?;
    }
    for item in &state.items {
        out.bytes(&item.area_id.map_or([0; 16], |id| id.0))?;
    }
    for routine in &state.routines {
        out.bytes(&routine.routine_id.0)?;
        out.bytes(&routine.created_by.0)?;
        out.bytes(&routine.created_at.to_le_bytes())?;
        out.u32(routine.created_on.encoded())?;
        out.u32(routine.occurrence_key.map_or(0, CivilDate::encoded))?;
        out.u8(routine.cadence as u8)?;
        out.u8(u8::from(routine.archived))?;
        out.u8(if routine.occurrence_key.is_none() {
            0
        } else if routine.completed {
            2
        } else {
            1
        })?;
        out.u8(0)?;
        out.text(&routine.text)?;
    }
    for area in &state.areas {
        let name = crate::state::normalize_area_name(&area.name)?;
        out.bytes(&area.area_id.0)?;
        out.u8(u8::from(area.archived))?;
        out.bytes(&[0; 3])?;
        out.text(&name)?;
    }
    for note in &state.notes {
        let (title, body) = crate::state::normalize_note(&note.title, &note.body)?;
        out.bytes(&note.note_id.0)?;
        out.bytes(&note.created_by.0)?;
        out.bytes(&note.updated_by.0)?;
        out.bytes(&note.created_at.to_le_bytes())?;
        out.bytes(&note.updated_at.to_le_bytes())?;
        out.bytes(&note.area_id.map_or([0; 16], |id| id.0))?;
        out.u8(u8::from(note.status == NoteStatus::Archived))?;
        out.bytes(&[0; 3])?;
        out.count(title.len())?;
        out.count(body.len())?;
        out.bytes(title.as_bytes())?;
        out.bytes(body.as_bytes())?;
    }
    for item in &state.items {
        for step in &item.steps {
            let text = crate::state::normalize_step_text(&step.text)?;
            out.bytes(&item.item_id.0)?;
            out.bytes(&step.step_id.0)?;
            out.u8(u8::from(step.completed))?;
            out.u8(u8::from(step.archived))?;
            out.bytes(&[0; 2])?;
            out.text(&text)?;
        }
    }
    for item in &state.items {
        out.u32(item.planning_date.map_or(0, CivilDate::encoded))?;
    }
    for item in &state.items {
        out.bytes(&item.last_changed_at.to_le_bytes())?;
    }
    for pin in &state.pins {
        out.u8(pin.target_kind as u8)?;
        out.bytes(&[0; 3])?;
        out.bytes(&pin.target_id)?;
    }
    for record in &state.playbooks {
        out.bytes(&record.playbook_id.0)?;
        out.u8(u8::from(record.archived))?;
        out.u8(record.entries.len() as u8)?;
        out.u16(record.title.len() as u16)?;
        out.bytes(&[0; 2])?;
        out.bytes(record.title.as_bytes())?;
        for entry in &record.entries {
            out.u16(entry.len() as u16)?;
            out.bytes(entry.as_bytes())?;
        }
    }
    for record in &state.reference_records {
        let (title, fields) = crate::state::normalize_reference_text(
            &record.title,
            &record
                .fields
                .iter()
                .map(|field| (field.field_id, field.label.clone(), field.value.clone()))
                .collect::<Vec<_>>(),
        )?;
        out.bytes(&record.record_id.0)?;
        out.bytes(&record.area_id.map_or([0; 16], |id| id.0))?;
        out.u16(title.len() as u16)?;
        out.u8(fields.len() as u8)?;
        out.u8(u8::from(record.archived))?;
        out.bytes(title.as_bytes())?;
        for field in fields {
            out.bytes(&field.field_id.0)?;
            out.u16(field.label.len() as u16)?;
            out.u16(field.value.len() as u16)?;
            out.bytes(field.label.as_bytes())?;
            out.bytes(field.value.as_bytes())?;
        }
    }
    for entry in &state.maintenance_events {
        out.bytes(&entry.maintenance_id.0)?;
        out.bytes(&entry.record_id.0)?;
        out.u32(entry.performed_on.encoded())?;
        out.u32(entry.next_on.map_or(0, CivilDate::encoded))?;
        out.bytes(&entry.routine_id.map_or([0; 16], |id| id.0))?;
        out.u8(u8::from(entry.archived))?;
        out.u8(0)?;
        out.u16(entry.summary.len() as u16)?;
        out.bytes(entry.summary.as_bytes())?;
    }
    for entry in &state.attachments {
        out.bytes(&entry.attachment_id.0)?;
        out.u8(entry.parent_kind as u8)?;
        out.u8(u8::from(entry.removed))?;
        out.bytes(&[0; 2])?;
        out.bytes(&entry.parent_id)?;
    }
    for entry in &state.responsibilities {
        out.u8(entry.target_kind as u8)?;
        out.bytes(&entry.target_id)?;
        out.bytes(&entry.member_id.map_or([0; 16], |id| id.0))?;
    }
    for routine in &state.routines {
        out.u32(routine.next_start.map_or(0, CivilDate::encoded))?;
    }
    for entry in &summary.entries {
        out.reserve(SUMMARY_HEADER_BYTES + entry.text.len())?;
        out.bytes(&entry.event_id.0)?;
        out.u8(entry.kind as u8)?;
        out.u8(entry.entity_kind as u8)?;
        out.u8(entry.classification.map_or(u8::MAX, classification_code))?;
        out.u8(0)?;
        out.text(&entry.text)?;
    }
    Ok(out.0)
}

/// Structural checks on the derived state that must hold before encoding; a
/// failure means the projection is not representable, never a partial result.
fn validate(state: &HouseholdState, summary: &CatchUpSummary) -> Result<(), KinError> {
    if state
        .items
        .len()
        .saturating_add(state.handoffs.len())
        .saturating_add(state.talks.len())
        .saturating_add(state.pulses.len())
        .saturating_add(state.routines.len())
        > MAX_EVENT_COUNT
        || state.pins.len() > crate::state::MAX_PINS
        || state.areas.len() > crate::state::MAX_AREAS
        || state.notes.len() > crate::state::MAX_NOTES
        || state.reference_records.len() > crate::state::MAX_REFERENCE_RECORDS
        || state.maintenance_events.len() > MAX_MAINTENANCE_EVENTS
        || state.attachments.len() > crate::state::MAX_ATTACHMENTS
        || state
            .items
            .iter()
            .any(|item| item.steps.len() > crate::state::MAX_STEPS_PER_ITEM)
    {
        return Err(KinError::SizeLimit);
    }
    for routine in &state.routines {
        if routine.text.is_empty()
            || routine.text.len() > MAX_ITEM_TEXT_BYTES
            || !valid_timestamp(routine.created_at)
            || (routine.archived && routine.occurrence_key.is_some())
            || (routine.completed && routine.occurrence_key.is_none())
            || (routine.archived && routine.next_start.is_some())
            || routine
                .next_start
                .zip(routine.occurrence_key)
                .is_some_and(|(next, key)| next <= key)
        {
            return Err(KinError::MalformedProtocol);
        }
        if let Some(key) = routine.occurrence_key {
            routine.cadence.validate_key(routine.created_on, key)?;
        }
    }
    if state
        .items
        .iter()
        .any(|item| !valid_timestamp(item.last_changed_at))
    {
        return Err(KinError::MalformedProtocol);
    }
    let summary_count = summary.entries.len();
    if summary_count > MAX_SUMMARY_ENTRIES
        || summary_count > summary.total_count as usize
        || summary.total_count as usize > MAX_EVENT_COUNT
        || (summary.total_count > 0 && summary.through_event_id.is_none())
    {
        return Err(KinError::MalformedProtocol);
    }
    for entry in &summary.entries {
        let expected_entity = match entry.kind {
            SummaryKind::ItemAdded
            | SummaryKind::ItemCompleted
            | SummaryKind::ItemReopened
            | SummaryKind::ItemArchived => SummaryEntityKind::Item,
            SummaryKind::HandoffAdded
            | SummaryKind::HandoffAcknowledged
            | SummaryKind::HandoffArchived => SummaryEntityKind::Handoff,
            SummaryKind::TalkAdded
            | SummaryKind::TalkResolved
            | SummaryKind::TalkReopened
            | SummaryKind::TalkArchived => SummaryEntityKind::Talk,
            SummaryKind::RoutineCreated
            | SummaryKind::RoutineOccurrenceCompleted
            | SummaryKind::RoutineOccurrenceReopened
            | SummaryKind::RoutineArchived => SummaryEntityKind::Routine,
        };
        if entry.entity_kind != expected_entity
            || (entry.kind == SummaryKind::ItemAdded) != entry.classification.is_some()
            || entry.text.is_empty()
            || entry.text.len() > MAX_ITEM_TEXT_BYTES
        {
            return Err(KinError::MalformedProtocol);
        }
    }
    Ok(())
}
