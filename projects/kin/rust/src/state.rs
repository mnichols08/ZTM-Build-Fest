use std::collections::{BTreeMap, BTreeSet};

use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, AreaId, DeviceId, EventEnvelope, EventId, EventKind, HandoffId,
    HouseholdId, ItemClassification, ItemId, NoteId, PulseValue, RoutineId, TalkId,
};
use crate::recurrence::{Cadence, CivilDate};

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
    pub classification: ItemClassification,
    pub status: ItemStatus,
    pub area_id: Option<AreaId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AreaState {
    pub area_id: AreaId,
    pub name: String,
    pub archived: bool,
}

pub const MAX_AREAS: usize = 32;
pub const MAX_AREA_NAME_BYTES: usize = 96;
pub const MAX_AREA_NAME_CHARS: usize = 48;
pub const MAX_NOTES: usize = 128;
pub const MAX_NOTE_TITLE_BYTES: usize = 256;
pub const MAX_NOTE_TITLE_CHARS: usize = 80;
pub const MAX_NOTE_BODY_BYTES: usize = 4 * 1024;

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
    pub items: Vec<ItemState>,
    pub handoffs: Vec<HandoffState>,
    pub talks: Vec<TalkState>,
    pub pulses: Vec<PulseState>,
    pub routines: Vec<RoutineState>,
    pub areas: Vec<AreaState>,
    pub notes: Vec<NoteState>,
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

pub fn rebuild(events: &[EventEnvelope]) -> Result<HouseholdState, KinError> {
    if events
        .iter()
        .any(|e| matches!(e.kind, EventKind::PulseSet { .. } | EventKind::PulseCleared))
    {
        return Err(KinError::UnsupportedVersion);
    }
    rebuild_at(events, 0)
}

pub fn rebuild_at(events: &[EventEnvelope], as_of: i64) -> Result<HouseholdState, KinError> {
    rebuild_with_context(events, as_of, None, false)
}

pub fn rebuild_on(
    events: &[EventEnvelope],
    as_of: i64,
    civil_date: CivilDate,
) -> Result<HouseholdState, KinError> {
    rebuild_with_context(events, as_of, Some(civil_date), false)
}

pub fn rebuild_distributed_on(
    events: &[EventEnvelope],
    as_of: i64,
    civil_date: CivilDate,
) -> Result<HouseholdState, KinError> {
    // Sort an owned copy for deterministic reduction; callers keep arrival order for cursors.
    let mut ordered_events = events.to_vec();
    ordered_events.sort_by_key(|event| (event.logical_time, event.device_id, event.event_id));
    rebuild_with_context(&ordered_events, as_of, Some(civil_date), true)
}

fn rebuild_with_context(
    events: &[EventEnvelope],
    as_of: i64,
    civil_date: Option<CivilDate>,
    allow_equal_logical_time: bool,
) -> Result<HouseholdState, KinError> {
    if !valid_timestamp(as_of) {
        return Err(KinError::MalformedProtocol);
    }
    let mut pulses = BTreeMap::new();
    let mut routines: Vec<RoutineState> = Vec::new();
    let mut routine_positions = BTreeMap::new();
    let mut routine_archives = BTreeMap::new();
    let mut completed_periods = BTreeSet::new();
    let mut household_id = None;
    let mut items: Vec<ItemState> = Vec::new();
    let mut handoffs = Vec::new();
    let mut talks = Vec::new();
    let mut talk_positions = BTreeMap::new();
    let mut talk_archives = BTreeMap::new();
    let mut handoff_positions = BTreeMap::new();
    let mut handoff_archives = BTreeMap::new();
    let mut item_positions: BTreeMap<crate::event::ItemId, usize> = BTreeMap::new();
    let mut item_archives = BTreeMap::new();
    let mut areas: Vec<AreaState> = Vec::new();
    let mut area_positions = BTreeMap::new();
    let mut notes: Vec<NoteState> = Vec::new();
    let mut note_positions = BTreeMap::new();
    let mut note_archive_events = BTreeMap::<NoteId, BTreeSet<(u64, DeviceId)>>::new();
    for event in events {
        if let EventKind::NoteArchived { note_id } = &event.kind {
            note_archive_events
                .entry(*note_id)
                .or_default()
                .insert((event.logical_time, event.device_id));
        }
    }
    let mut event_bytes = BTreeMap::<EventId, Vec<u8>>::new();
    // Completions are retained by occurrence key, then projected onto the requested date below.
    let mut last_logical_time = 0;

    for event in events {
        if let Some(previous_bytes) = event_bytes.get(&event.event_id) {
            if previous_bytes == &event.canonical_bytes {
                continue;
            }
            return Err(KinError::InvalidEvent);
        }

        if let Some(stream_household) = household_id {
            if stream_household != event.household_id {
                return Err(KinError::InvalidEvent);
            }
        } else {
            household_id = Some(event.household_id);
        }

        if event.logical_time < last_logical_time
            || (!allow_equal_logical_time && event.logical_time == last_logical_time)
        {
            return Err(KinError::InvalidEvent);
        }

        match &event.kind {
            EventKind::AreaCreated { area_id, name } => {
                let name = normalize_area_name(name)?;
                if !valid_timestamp(event.timestamp)
                    || area_id.0 == [0; 16]
                    || area_positions.contains_key(area_id)
                    || areas.len() >= MAX_AREAS
                {
                    return Err(KinError::InvalidEvent);
                }
                area_positions.insert(*area_id, areas.len());
                areas.push(AreaState {
                    area_id: *area_id,
                    name,
                    archived: false,
                });
            }
            EventKind::AreaRenamed { area_id, name } => {
                let name = normalize_area_name(name)?;
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = area_positions
                    .get(area_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                areas[position].name = name;
            }
            EventKind::AreaArchived { area_id } => {
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = area_positions
                    .get(area_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                areas[position].archived = true;
            }
            EventKind::ItemAreaChanged { item_id, area_id } => {
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = item_positions
                    .get(item_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                if area_id.is_some_and(|id| !area_positions.contains_key(&id)) {
                    return Err(KinError::InvalidEvent);
                }
                items[position].area_id = *area_id;
            }
            EventKind::NoteCreated {
                note_id,
                title,
                body,
                area_id,
            } => {
                let (title, body) = normalize_note(title, body)?;
                if !valid_timestamp(event.timestamp)
                    || note_id.0 == [0; 16]
                    || note_positions.contains_key(note_id)
                    || notes.len() >= MAX_NOTES
                    || area_id.is_some_and(|id| {
                        area_positions
                            .get(&id)
                            .is_none_or(|position| areas[*position].archived)
                    })
                {
                    return Err(KinError::InvalidEvent);
                }
                note_positions.insert(*note_id, notes.len());
                notes.push(NoteState {
                    note_id: *note_id,
                    title,
                    body,
                    area_id: *area_id,
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    updated_by: event.actor_id,
                    updated_at: event.timestamp,
                    status: NoteStatus::Active,
                });
            }
            EventKind::NoteUpdated {
                note_id,
                title,
                body,
                area_id,
            } => {
                let (title, body) = normalize_note(title, body)?;
                let position = note_positions
                    .get(note_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                if !valid_timestamp(event.timestamp)
                    || area_id.is_some_and(|id| {
                        area_positions.get(&id).is_none_or(|area_position| {
                            areas[*area_position].archived && notes[position].area_id != Some(id)
                        })
                    })
                {
                    return Err(KinError::InvalidEvent);
                }
                let concurrent_archive = allow_equal_logical_time
                    && note_archive_events.get(note_id).is_some_and(|archives| {
                        archives.iter().any(|(logical_time, device_id)| {
                            *logical_time == event.logical_time && *device_id != event.device_id
                        })
                    });
                if notes[position].status == NoteStatus::Archived && !concurrent_archive {
                    return Err(KinError::InvalidEvent);
                }
                if !concurrent_archive {
                    notes[position].title = title;
                    notes[position].body = body;
                    notes[position].area_id = *area_id;
                    notes[position].updated_by = event.actor_id;
                    notes[position].updated_at = event.timestamp;
                }
            }
            EventKind::NoteArchived { note_id } => {
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = note_positions
                    .get(note_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                let concurrent_archive = allow_equal_logical_time
                    && note_archive_events.get(note_id).is_some_and(|archives| {
                        archives.iter().any(|(logical_time, device_id)| {
                            *logical_time == event.logical_time && *device_id != event.device_id
                        })
                    });
                if notes[position].status == NoteStatus::Archived && !concurrent_archive {
                    return Err(KinError::InvalidEvent);
                }
                notes[position].status = NoteStatus::Archived;
            }
            EventKind::RoutineCreated {
                routine_id,
                text,
                cadence,
                created_on,
            } => {
                let today = civil_date.ok_or(KinError::UnsupportedVersion)?;
                if !valid_timestamp(event.timestamp) || text.len() > 4096 || text.is_empty() {
                    return Err(KinError::MalformedProtocol);
                }
                if text.trim().is_empty() || routine_positions.contains_key(routine_id) {
                    return Err(KinError::InvalidEvent);
                }
                routine_positions.insert(*routine_id, routines.len());
                routines.push(RoutineState {
                    routine_id: *routine_id,
                    text: text.clone(),
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    created_on: *created_on,
                    cadence: *cadence,
                    archived: false,
                    occurrence_key: cadence.current_key(*created_on, today),
                    completed: false,
                });
            }
            EventKind::RoutineOccurrenceCompleted { routine_id, key }
            | EventKind::RoutineOccurrenceReopened { routine_id, key } => {
                civil_date.ok_or(KinError::UnsupportedVersion)?;
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = routine_positions
                    .get(routine_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                let routine = &routines[position];
                routine.cadence.validate_key(routine.created_on, *key)?;
                if routine.archived {
                    if !is_concurrent_terminal_conflict(
                        allow_equal_logical_time,
                        routine_archives.get(routine_id).copied(),
                        event,
                    ) {
                        return Err(KinError::InvalidEvent);
                    }
                } else if matches!(event.kind, EventKind::RoutineOccurrenceCompleted { .. }) {
                    completed_periods.insert((*routine_id, *key));
                } else {
                    completed_periods.remove(&(*routine_id, *key));
                }
            }
            EventKind::RoutineArchived { routine_id } => {
                civil_date.ok_or(KinError::UnsupportedVersion)?;
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                let position = routine_positions
                    .get(routine_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                let routine = &mut routines[position];
                if routine.archived {
                    if !is_concurrent_terminal_conflict(
                        allow_equal_logical_time,
                        routine_archives.get(routine_id).copied(),
                        event,
                    ) {
                        return Err(KinError::InvalidEvent);
                    }
                } else {
                    routine.archived = true;
                    routine.occurrence_key = None;
                    routine_archives.insert(*routine_id, (event.logical_time, event.device_id));
                }
            }
            EventKind::PulseSet { value, expires_at } => {
                if !valid_timestamp(event.timestamp) || !valid_timestamp(*expires_at) {
                    return Err(KinError::MalformedProtocol);
                }
                if *expires_at <= event.timestamp {
                    return Err(KinError::InvalidEvent);
                }
                pulses.insert(
                    event.actor_id,
                    PulseState {
                        actor_id: event.actor_id,
                        value: *value,
                        set_at: event.timestamp,
                        expires_at: *expires_at,
                        status: if as_of < *expires_at {
                            PulseStatus::Active
                        } else {
                            PulseStatus::Expired
                        },
                    },
                );
            }
            EventKind::PulseCleared => {
                if !valid_timestamp(event.timestamp) {
                    return Err(KinError::MalformedProtocol);
                }
                pulses.remove(&event.actor_id);
            }
            EventKind::TalkAdded { talk_id, text } => {
                if text.trim().is_empty() || talk_positions.contains_key(talk_id) {
                    return Err(KinError::InvalidEvent);
                }
                talk_positions.insert(*talk_id, talks.len());
                talks.push(TalkState {
                    talk_id: *talk_id,
                    text: text.clone(),
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    status: TalkStatus::Open,
                });
            }
            EventKind::TalkResolved { talk_id }
            | EventKind::TalkReopened { talk_id }
            | EventKind::TalkArchived { talk_id } => {
                let position = talk_positions
                    .get(talk_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                let talk = &mut talks[position];
                if talk.status == TalkStatus::Archived {
                    if !is_concurrent_terminal_conflict(
                        allow_equal_logical_time,
                        talk_archives.get(talk_id).copied(),
                        event,
                    ) {
                        return Err(KinError::InvalidEvent);
                    }
                } else if matches!(event.kind, EventKind::TalkArchived { .. }) {
                    talk.status = TalkStatus::Archived;
                    talk_archives.insert(*talk_id, (event.logical_time, event.device_id));
                } else {
                    talk.status = match event.kind {
                        EventKind::TalkResolved { .. } => TalkStatus::Resolved,
                        EventKind::TalkReopened { .. } => TalkStatus::Open,
                        _ => return Err(KinError::InvalidEvent),
                    };
                }
            }
            EventKind::HandoffAdded { handoff_id, text } => {
                if text.trim().is_empty() || handoff_positions.contains_key(handoff_id) {
                    return Err(KinError::InvalidEvent);
                }
                handoff_positions.insert(*handoff_id, handoffs.len());
                handoffs.push(HandoffState {
                    handoff_id: *handoff_id,
                    text: text.clone(),
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    status: HandoffStatus::Unacknowledged,
                });
            }
            EventKind::HandoffAcknowledged { handoff_id }
            | EventKind::HandoffArchived { handoff_id } => {
                let position = handoff_positions
                    .get(handoff_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                let handoff = &mut handoffs[position];
                if handoff.status == HandoffStatus::Archived {
                    if !is_concurrent_terminal_conflict(
                        allow_equal_logical_time,
                        handoff_archives.get(handoff_id).copied(),
                        event,
                    ) {
                        return Err(KinError::InvalidEvent);
                    }
                } else if matches!(event.kind, EventKind::HandoffArchived { .. }) {
                    handoff.status = HandoffStatus::Archived;
                    handoff_archives.insert(*handoff_id, (event.logical_time, event.device_id));
                } else {
                    handoff.status = HandoffStatus::Acknowledged;
                }
            }
            EventKind::ItemAdded {
                item_id,
                text,
                classification,
            } => {
                if text.trim().is_empty() || item_positions.contains_key(item_id) {
                    return Err(KinError::InvalidEvent);
                }
                item_positions.insert(*item_id, items.len());
                items.push(ItemState {
                    item_id: *item_id,
                    text: text.clone(),
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    classification: *classification,
                    status: ItemStatus::Active,
                    area_id: None,
                });
            }
            EventKind::ItemCompleted { item_id } => {
                let position = item_positions
                    .get(item_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                match items[position].status {
                    ItemStatus::Active => items[position].status = ItemStatus::Completed,
                    ItemStatus::Completed => {}
                    ItemStatus::Archived => {
                        if !is_concurrent_terminal_conflict(
                            allow_equal_logical_time,
                            item_archives.get(item_id).copied(),
                            event,
                        ) {
                            return Err(KinError::InvalidEvent);
                        }
                    }
                }
            }
            EventKind::ItemReopened { item_id } => {
                let position = item_positions
                    .get(item_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                match items[position].status {
                    ItemStatus::Active => {}
                    ItemStatus::Completed => items[position].status = ItemStatus::Active,
                    ItemStatus::Archived => {
                        if !is_concurrent_terminal_conflict(
                            allow_equal_logical_time,
                            item_archives.get(item_id).copied(),
                            event,
                        ) {
                            return Err(KinError::InvalidEvent);
                        }
                    }
                }
            }
            EventKind::ItemArchived { item_id } => {
                let position = item_positions
                    .get(item_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                match items[position].status {
                    ItemStatus::Active | ItemStatus::Completed => {
                        items[position].status = ItemStatus::Archived;
                        item_archives.insert(*item_id, (event.logical_time, event.device_id));
                    }
                    ItemStatus::Archived => {
                        if !is_concurrent_terminal_conflict(
                            allow_equal_logical_time,
                            item_archives.get(item_id).copied(),
                            event,
                        ) {
                            return Err(KinError::InvalidEvent);
                        }
                    }
                }
            }
        }

        last_logical_time = event.logical_time;
        event_bytes.insert(event.event_id, event.canonical_bytes.clone());
    }

    for routine in &mut routines {
        routine.completed = routine
            .occurrence_key
            .is_some_and(|key| completed_periods.contains(&(routine.routine_id, key)));
    }
    Ok(HouseholdState {
        household_id,
        items,
        handoffs,
        talks,
        pulses: pulses.into_values().collect(),
        routines,
        areas,
        notes,
    })
}

fn is_concurrent_terminal_conflict(
    allow_equal_logical_time: bool,
    archived_by: Option<(u64, DeviceId)>,
    event: &EventEnvelope,
) -> bool {
    // Cross-device mutations at the archive's logical time cannot undo its terminal tombstone.
    allow_equal_logical_time
        && archived_by.is_some_and(|(logical_time, device_id)| {
            logical_time == event.logical_time && device_id != event.device_id
        })
}

pub fn summarize(
    events: &[EventEnvelope],
    cursor: Option<EventId>,
) -> Result<CatchUpSummary, KinError> {
    let state = rebuild_at(events, 0)?;
    summarize_validated(events, cursor, &state)
}

pub(crate) fn summarize_validated(
    events: &[EventEnvelope],
    cursor: Option<EventId>,
    state: &HouseholdState,
) -> Result<CatchUpSummary, KinError> {
    let start = match cursor {
        Some(cursor_id) => events
            .iter()
            .position(|event| event.event_id == cursor_id)
            .map(|index| index + 1)
            .ok_or(KinError::InvalidEvent)?,
        None => 0,
    };
    let mut seen: BTreeSet<EventId> = events[..start].iter().map(|event| event.event_id).collect();
    let items: BTreeMap<ItemId, (&str, ItemClassification)> = state
        .items
        .iter()
        .map(|item| (item.item_id, (item.text.as_str(), item.classification)))
        .collect();
    let handoffs: BTreeMap<HandoffId, &str> = state
        .handoffs
        .iter()
        .map(|handoff| (handoff.handoff_id, handoff.text.as_str()))
        .collect();
    let talks: BTreeMap<TalkId, &str> = state
        .talks
        .iter()
        .map(|talk| (talk.talk_id, talk.text.as_str()))
        .collect();
    let mut entries = Vec::new();
    let routines: BTreeMap<RoutineId, &str> = state
        .routines
        .iter()
        .map(|routine| (routine.routine_id, routine.text.as_str()))
        .collect();
    let mut total_count = 0u32;

    for event in &events[start..] {
        if !seen.insert(event.event_id) {
            continue;
        }
        let summary = match &event.kind {
            EventKind::RoutineCreated { text, .. } => Some((
                SummaryKind::RoutineCreated,
                SummaryEntityKind::Routine,
                text.as_str(),
                None,
            )),
            EventKind::RoutineOccurrenceCompleted { routine_id, .. } => {
                routines.get(routine_id).map(|text| {
                    (
                        SummaryKind::RoutineOccurrenceCompleted,
                        SummaryEntityKind::Routine,
                        *text,
                        None,
                    )
                })
            }
            EventKind::RoutineOccurrenceReopened { routine_id, .. } => {
                routines.get(routine_id).map(|text| {
                    (
                        SummaryKind::RoutineOccurrenceReopened,
                        SummaryEntityKind::Routine,
                        *text,
                        None,
                    )
                })
            }
            EventKind::RoutineArchived { routine_id } => routines.get(routine_id).map(|text| {
                (
                    SummaryKind::RoutineArchived,
                    SummaryEntityKind::Routine,
                    *text,
                    None,
                )
            }),
            EventKind::ItemAdded {
                item_id: _,
                text,
                classification,
            } => Some((
                SummaryKind::ItemAdded,
                SummaryEntityKind::Item,
                text.as_str(),
                Some(*classification),
            )),
            EventKind::ItemCompleted { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemCompleted,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::ItemReopened { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemReopened,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::ItemArchived { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemArchived,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::HandoffAdded { text, .. } => Some((
                SummaryKind::HandoffAdded,
                SummaryEntityKind::Handoff,
                text.as_str(),
                None,
            )),
            EventKind::HandoffAcknowledged { handoff_id } => handoffs.get(handoff_id).map(|text| {
                (
                    SummaryKind::HandoffAcknowledged,
                    SummaryEntityKind::Handoff,
                    *text,
                    None,
                )
            }),
            EventKind::HandoffArchived { handoff_id } => handoffs.get(handoff_id).map(|text| {
                (
                    SummaryKind::HandoffArchived,
                    SummaryEntityKind::Handoff,
                    *text,
                    None,
                )
            }),
            EventKind::TalkAdded { text, .. } => Some((
                SummaryKind::TalkAdded,
                SummaryEntityKind::Talk,
                text.as_str(),
                None,
            )),
            EventKind::TalkResolved { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkResolved,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::TalkReopened { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkReopened,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::TalkArchived { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkArchived,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::PulseSet { .. }
            | EventKind::PulseCleared
            | EventKind::AreaCreated { .. }
            | EventKind::AreaRenamed { .. }
            | EventKind::AreaArchived { .. }
            | EventKind::ItemAreaChanged { .. }
            | EventKind::NoteCreated { .. }
            | EventKind::NoteUpdated { .. }
            | EventKind::NoteArchived { .. } => None,
        };

        if let Some((kind, entity_kind, text, classification)) = summary {
            total_count = total_count.checked_add(1).ok_or(KinError::SizeLimit)?;
            if entries.len() == MAX_SUMMARY_ENTRIES {
                entries.remove(0);
            }
            entries.push(SummaryEntry {
                event_id: event.event_id,
                kind,
                entity_kind,
                text: text.to_owned(),
                classification,
            });
        }
    }

    Ok(CatchUpSummary {
        entries,
        total_count,
        through_event_id: events.last().map(|event| event.event_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{DeviceId, EventId};

    fn id(byte: u8) -> [u8; 16] {
        [byte; 16]
    }

    fn event(event_number: u8, logical_time: u64, kind: EventKind) -> EventEnvelope {
        let event_id = EventId(id(event_number));
        let mut canonical_bytes = vec![event_number, logical_time as u8];
        match &kind {
            EventKind::RoutineCreated { .. }
            | EventKind::RoutineOccurrenceCompleted { .. }
            | EventKind::RoutineOccurrenceReopened { .. }
            | EventKind::RoutineArchived { .. } => {
                panic!("Routine tests use independent wire fixtures")
            }
            EventKind::PulseSet { value, expires_at } => {
                canonical_bytes.push(*value as u8);
                canonical_bytes.extend_from_slice(&expires_at.to_le_bytes());
            }
            EventKind::PulseCleared => canonical_bytes.push(13),
            EventKind::TalkAdded { talk_id, text } => {
                canonical_bytes.extend_from_slice(&talk_id.0);
                canonical_bytes.extend_from_slice(text.as_bytes());
            }
            EventKind::TalkResolved { talk_id }
            | EventKind::TalkReopened { talk_id }
            | EventKind::TalkArchived { talk_id } => {
                canonical_bytes.extend_from_slice(&talk_id.0);
            }
            EventKind::HandoffAdded { handoff_id, text } => {
                canonical_bytes.extend_from_slice(&handoff_id.0);
                canonical_bytes.extend_from_slice(text.as_bytes());
            }
            EventKind::HandoffAcknowledged { handoff_id }
            | EventKind::HandoffArchived { handoff_id } => {
                canonical_bytes.extend_from_slice(&handoff_id.0);
            }
            EventKind::ItemAdded { item_id, text, .. } => {
                canonical_bytes.extend_from_slice(&item_id.0);
                canonical_bytes.extend_from_slice(text.as_bytes());
            }
            EventKind::ItemCompleted { item_id }
            | EventKind::ItemReopened { item_id }
            | EventKind::ItemArchived { item_id } => {
                canonical_bytes.extend_from_slice(&item_id.0);
            }
            EventKind::AreaCreated { .. }
            | EventKind::AreaRenamed { .. }
            | EventKind::AreaArchived { .. }
            | EventKind::ItemAreaChanged { .. }
            | EventKind::NoteCreated { .. }
            | EventKind::NoteUpdated { .. }
            | EventKind::NoteArchived { .. } => {
                panic!("Area tests use independent wire fixtures")
            }
        }
        EventEnvelope {
            event_id,
            household_id: HouseholdId(id(0xaa)),
            actor_id: ActorId(id(0xbb)),
            device_id: DeviceId(id(0xcc)),
            timestamp: 1_760_000_000_000 + i64::from(event_number),
            logical_time,
            event_version: 1,
            kind,
            canonical_bytes,
        }
    }

    fn added(event_number: u8, logical_time: u64, item_number: u8, text: &str) -> EventEnvelope {
        event(
            event_number,
            logical_time,
            EventKind::ItemAdded {
                item_id: ItemId(id(item_number)),
                text: text.to_owned(),
                classification: ItemClassification::Need,
            },
        )
    }

    #[test]
    fn add_item_creates_active_item() {
        let state = rebuild(&[added(1, 1, 0x11, "Buy milk")]).unwrap();
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[0].status, ItemStatus::Active);
    }

    #[test]
    fn multiple_items_keep_addition_order() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            added(2, 2, 0x22, "Restock wipes"),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items.len(), 2);
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[1].text, "Restock wipes");
    }

    #[test]
    fn completion_changes_only_derived_status() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[0].status, ItemStatus::Completed);
    }

    #[test]
    fn unknown_completion_is_invalid() {
        let completion = event(
            1,
            1,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0xff)),
            },
        );
        assert_eq!(rebuild(&[completion]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn identical_event_delivery_is_idempotent() {
        let added = added(1, 1, 0x11, "Buy milk");
        let state = rebuild(&[added.clone(), added]).unwrap();
        assert_eq!(state.items.len(), 1);
    }

    #[test]
    fn event_id_reuse_with_different_bytes_fails() {
        let first = added(1, 1, 0x11, "Buy milk");
        let mut conflicting = added(2, 2, 0x22, "Restock wipes");
        conflicting.event_id = first.event_id;
        assert_eq!(rebuild(&[first, conflicting]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn duplicate_completion_is_a_valid_noop() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
            event(
                3,
                3,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items[0].status, ItemStatus::Completed);
    }

    #[test]
    fn rebuild_is_deterministic() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state_a = rebuild(&events).unwrap();
        let state_b = rebuild(&events).unwrap();
        let state_c = rebuild(&events).unwrap();
        assert_eq!(state_a, state_b);
        assert_eq!(state_b, state_c);
        assert_eq!(state_a, state_c);
    }

    #[test]
    fn mixed_households_fail_as_a_whole() {
        let first = added(1, 1, 0x11, "Buy milk");
        let mut second = added(2, 2, 0x22, "Restock wipes");
        second.household_id = HouseholdId(id(0xdd));
        assert_eq!(rebuild(&[first, second]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn whitespace_only_items_are_invalid() {
        assert_eq!(
            rebuild(&[added(1, 1, 0x11, " \t\n")]),
            Err(KinError::InvalidEvent)
        );
    }

    #[test]
    fn reopening_completed_and_active_items_is_valid() {
        let item_id = ItemId(id(0x11));
        let completed_then_reopened = [
            added(1, 1, 0x11, "Buy milk"),
            event(2, 2, EventKind::ItemCompleted { item_id }),
            event(3, 3, EventKind::ItemReopened { item_id }),
        ];
        let reopened_state = rebuild(&completed_then_reopened).unwrap();
        assert_eq!(reopened_state.items[0].status, ItemStatus::Active);

        let already_active = [
            added(1, 1, 0x11, "Buy milk"),
            event(2, 2, EventKind::ItemReopened { item_id }),
        ];
        let active_state = rebuild(&already_active).unwrap();
        assert_eq!(active_state.items[0].status, ItemStatus::Active);
    }

    #[test]
    fn archiving_active_or_completed_items_is_terminal() {
        let item_id = ItemId(id(0x11));
        for prefix in [
            vec![added(1, 1, 0x11, "Buy milk")],
            vec![
                added(1, 1, 0x11, "Buy milk"),
                event(2, 2, EventKind::ItemCompleted { item_id }),
            ],
        ] {
            let mut archived_events = prefix.clone();
            archived_events.push(event(
                archived_events.len() as u8 + 1,
                archived_events.len() as u64 + 1,
                EventKind::ItemArchived { item_id },
            ));
            let archived_state = rebuild(&archived_events).unwrap();
            assert_eq!(archived_state.items[0].status, ItemStatus::Archived);

            for mutation in [
                EventKind::ItemCompleted { item_id },
                EventKind::ItemReopened { item_id },
                EventKind::ItemArchived { item_id },
            ] {
                let mut invalid_events = archived_events.clone();
                invalid_events.push(event(
                    invalid_events.len() as u8 + 1,
                    invalid_events.len() as u64 + 1,
                    mutation,
                ));
                assert_eq!(rebuild(&invalid_events), Err(KinError::InvalidEvent));
            }
        }
    }

    #[test]
    fn unknown_reopen_and_archive_references_are_invalid() {
        let item_id = ItemId(id(0xff));
        for kind in [
            EventKind::ItemReopened { item_id },
            EventKind::ItemArchived { item_id },
        ] {
            assert_eq!(rebuild(&[event(1, 1, kind)]), Err(KinError::InvalidEvent));
        }
    }

    #[test]
    fn duplicate_item_identity_is_invalid() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            added(2, 2, 0x11, "Restock wipes"),
        ];
        assert_eq!(rebuild(&events), Err(KinError::InvalidEvent));
    }

    #[test]
    fn non_increasing_logical_order_is_invalid() {
        let events = [
            added(1, 2, 0x11, "Buy milk"),
            added(2, 2, 0x22, "Restock wipes"),
        ];
        assert_eq!(rebuild(&events), Err(KinError::InvalidEvent));
    }
}
