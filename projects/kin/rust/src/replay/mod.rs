//! Household replay: reducing canonical events into household state.
//!
//! A `Replay` holds the state built so far. Events are applied one at a time
//! in replay order, `(logical_time, device_id, event_id)`, through `apply`,
//! which checks what every event must satisfy and hands the event to its
//! domain's reducer (items.rs, conversations.rs, routines.rs, records.rs,
//! household.rs). `finalize` then produces the `HouseholdState` for one
//! evaluation time and civil date without changing the replay, so the same
//! replay can be finalized again later or extended with newer events.
//!
//! Only two things depend on the evaluation time and date, and both are
//! derived in `finalize`: whether a Pulse has expired, and each Routine's
//! current occurrence and next start. Everything a reducer decides depends on
//! the events alone.
//!
//! Concurrent archives: several reducers treat an archive event from another
//! device at the same logical time as concurrent (it wins over the other
//! change). They look the archives up in sets collected from every event to
//! be replayed (`note_archives`), so call it with all events before applying
//! them, and with each later batch before applying that batch. Because only
//! equal logical times count, a batch whose events all come strictly later
//! than the last applied event cannot change any earlier decision.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::*;
use crate::recurrence::CivilDate;
use crate::state::*;

mod conversations;
mod household;
mod items;
mod records;
mod routines;

#[derive(Clone, Default)]
pub struct Replay {
    /// The stream's household; every event must match it.
    pub(super) household_id: Option<HouseholdId>,
    pub(super) mode: HouseholdMode,
    pub(super) items: Vec<ItemState>,
    pub(super) item_positions: BTreeMap<ItemId, usize>,
    /// Which event archived an Item: (logical time, device).
    pub(super) item_archives: BTreeMap<ItemId, (u64, DeviceId)>,
    /// Every archive event per Item in the whole history, for concurrent-archive checks (equal logical time, other device).
    pub(super) item_archive_events: BTreeMap<ItemId, BTreeSet<(u64, DeviceId)>>,
    pub(super) step_archive_events: BTreeMap<StepId, BTreeSet<(u64, DeviceId)>>,
    pub(super) seen_step_ids: BTreeSet<StepId>,
    pub(super) handoffs: Vec<HandoffState>,
    pub(super) handoff_positions: BTreeMap<HandoffId, usize>,
    pub(super) handoff_archives: BTreeMap<HandoffId, (u64, DeviceId)>,
    pub(super) talks: Vec<TalkState>,
    pub(super) talk_positions: BTreeMap<TalkId, usize>,
    pub(super) talk_archives: BTreeMap<TalkId, (u64, DeviceId)>,
    /// Latest Pulse per member; `status` is set by finalize.
    pub(super) pulses: BTreeMap<ActorId, PulseState>,
    /// Occurrence fields are set by finalize.
    pub(super) routines: Vec<RoutineState>,
    pub(super) routine_positions: BTreeMap<RoutineId, usize>,
    pub(super) routine_archives: BTreeMap<RoutineId, (u64, DeviceId)>,
    /// Completed occurrences by key, projected onto the civil date in finalize.
    pub(super) completed_periods: BTreeSet<(RoutineId, CivilDate)>,
    pub(super) areas: Vec<AreaState>,
    pub(super) area_positions: BTreeMap<AreaId, usize>,
    pub(super) notes: Vec<NoteState>,
    pub(super) note_positions: BTreeMap<NoteId, usize>,
    pub(super) note_archive_events: BTreeMap<NoteId, BTreeSet<(u64, DeviceId)>>,
    pub(super) reference_records: Vec<ReferenceRecordState>,
    pub(super) reference_positions: BTreeMap<ReferenceRecordId, usize>,
    pub(super) reference_field_owners: BTreeMap<ReferenceFieldId, ReferenceRecordId>,
    pub(super) reference_archive_events: BTreeMap<ReferenceRecordId, BTreeSet<(u64, DeviceId)>>,
    pub(super) maintenance_events: Vec<MaintenanceEventState>,
    pub(super) attachments: Vec<AttachmentState>,
    pub(super) responsibilities: Vec<ResponsibilityState>,
    /// Pins as replayed; finalize drops those whose target is archived.
    pub(super) pins: Vec<PinState>,
    pub(super) playbooks: Vec<PlaybookState>,
    /// Canonical bytes per applied event: an exact duplicate is skipped, a conflicting one fails. Shared, so cloning a Replay does not copy them.
    pub(super) event_bytes: BTreeMap<EventId, Arc<[u8]>>,
    /// Logical time of the last applied event; replay order never goes back.
    pub(super) last_logical_time: u64,
}

impl Replay {
    pub fn new() -> Self {
        Self::default()
    }

    /// The logical time of the last applied event (0 before any). Replay
    /// order never goes back, so it is the greatest logical time applied.
    pub fn last_logical_time(&self) -> u64 {
        self.last_logical_time
    }

    /// The household every applied event belongs to (after bindings).
    pub fn household_id(&self) -> Option<HouseholdId> {
        self.household_id
    }

    /// Whether an event with this ID has been applied.
    pub fn contains_event(&self, event_id: EventId) -> bool {
        self.event_bytes.contains_key(&event_id)
    }

    /// Records the archive events among `events` for the concurrent-archive
    /// checks (see the module doc). Call before applying them.
    pub fn note_archives(&mut self, events: &[EventEnvelope]) {
        for event in events {
            match &event.kind {
                EventKind::NoteArchived { note_id } => {
                    self.note_archive_events
                        .entry(*note_id)
                        .or_default()
                        .insert((event.logical_time, event.device_id));
                }
                EventKind::ReferenceRecordArchived { record_id } => {
                    self.reference_archive_events
                        .entry(*record_id)
                        .or_default()
                        .insert((event.logical_time, event.device_id));
                }
                EventKind::ItemArchived { item_id } => {
                    self.item_archive_events
                        .entry(*item_id)
                        .or_default()
                        .insert((event.logical_time, event.device_id));
                }
                EventKind::ItemStepArchived { step_id, .. } => {
                    self.step_archive_events
                        .entry(*step_id)
                        .or_default()
                        .insert((event.logical_time, event.device_id));
                }
                _ => {}
            }
        }
    }

    /// Applies one event in replay order. An exact duplicate of an applied
    /// event is skipped; anything invalid fails, and the replay must then be
    /// discarded, since an event may be partly applied.
    pub fn apply(&mut self, event: &EventEnvelope) -> Result<(), KinError> {
        if let Some(previous_bytes) = self.event_bytes.get(&event.event_id) {
            if previous_bytes.as_ref() == event.canonical_bytes.as_slice() {
                return Ok(());
            }
            return Err(KinError::InvalidEvent);
        }
        if let Some(stream_household) = self.household_id {
            if stream_household != event.household_id {
                return Err(KinError::InvalidEvent);
            }
        } else {
            self.household_id = Some(event.household_id);
        }
        // Equal logical times are valid (distributed devices); going back is not.
        if event.logical_time == 0
            || event.logical_time > MAX_LOGICAL_TIME
            || event.logical_time.saturating_sub(self.last_logical_time) > MAX_LOGICAL_TIME_ADVANCE
            || event.logical_time < self.last_logical_time
        {
            return Err(KinError::InvalidEvent);
        }
        use EventKind as K;
        match &event.kind {
            K::ItemAdded { .. }
            | K::ItemAreaChanged { .. }
            | K::ItemPlanningDateChanged { .. }
            | K::ItemStepAdded { .. }
            | K::ItemStepCompleted { .. }
            | K::ItemStepReopened { .. }
            | K::ItemStepArchived { .. }
            | K::ItemCompleted { .. }
            | K::ItemReopened { .. }
            | K::ItemArchived { .. } => items::apply(self, event)?,
            K::HandoffAdded { .. }
            | K::HandoffAcknowledged { .. }
            | K::HandoffArchived { .. }
            | K::TalkAdded { .. }
            | K::TalkResolved { .. }
            | K::TalkReopened { .. }
            | K::TalkArchived { .. }
            | K::PulseSet { .. }
            | K::PulseCleared => conversations::apply(self, event)?,
            K::RoutineCreated { .. }
            | K::RoutineOccurrenceCompleted { .. }
            | K::RoutineOccurrenceReopened { .. }
            | K::RoutineArchived { .. }
            | K::PlaybookSaved { .. }
            | K::PlaybookArchived { .. } => routines::apply(self, event)?,
            K::AreaCreated { .. }
            | K::AreaRenamed { .. }
            | K::AreaArchived { .. }
            | K::NoteCreated { .. }
            | K::NoteUpdated { .. }
            | K::NoteArchived { .. }
            | K::ReferenceRecordSaved { .. }
            | K::ReferenceRecordArchived { .. }
            | K::MaintenanceEventSaved { .. }
            | K::MaintenanceEventArchived { .. }
            | K::AttachmentBound { .. }
            | K::AttachmentRemoved { .. } => records::apply(self, event)?,
            K::HouseholdModeChanged { .. }
            | K::PinAdded { .. }
            | K::PinRemoved { .. }
            | K::ResponsibilityChanged { .. } => household::apply(self, event)?,
        }
        self.last_logical_time = event.logical_time;
        self.event_bytes
            .insert(event.event_id, Arc::from(event.canonical_bytes.as_slice()));
        Ok(())
    }

    /// The household state at `as_of` (UTC milliseconds) on `civil_date`.
    /// Copies the replayed state; the replay itself is unchanged.
    pub fn finalize(&self, as_of: i64, civil_date: CivilDate) -> Result<HouseholdState, KinError> {
        if !valid_timestamp(as_of) {
            return Err(KinError::MalformedProtocol);
        }
        let mut routines = self.routines.clone();
        for routine in &mut routines {
            if routine.archived {
                routine.occurrence_key = None;
                routine.next_start = None;
            } else {
                routine.occurrence_key =
                    routine.cadence.current_key(routine.created_on, civil_date);
                routine.next_start = routine.cadence.next_start(routine.created_on, civil_date);
            }
            routine.completed = routine
                .occurrence_key
                .is_some_and(|key| self.completed_periods.contains(&(routine.routine_id, key)));
        }
        let pulses = self
            .pulses
            .values()
            .map(|pulse| PulseState {
                status: if as_of < pulse.expires_at {
                    PulseStatus::Active
                } else {
                    PulseStatus::Expired
                },
                ..pulse.clone()
            })
            .collect();
        // Pins whose target was archived are dropped from the result only:
        // while replaying they still count, as they always have.
        let mut pins = self.pins.clone();
        pins.retain(|pin| match pin.target_kind {
            PinTargetKind::Item => self
                .item_positions
                .get(&ItemId(pin.target_id))
                .is_some_and(|i| self.items[*i].status != ItemStatus::Archived),
            PinTargetKind::Note => self
                .note_positions
                .get(&NoteId(pin.target_id))
                .is_some_and(|i| self.notes[*i].status != NoteStatus::Archived),
            PinTargetKind::Routine => self
                .routine_positions
                .get(&RoutineId(pin.target_id))
                .is_some_and(|i| !self.routines[*i].archived),
            PinTargetKind::Area => self
                .area_positions
                .get(&AreaId(pin.target_id))
                .is_some_and(|i| !self.areas[*i].archived),
        });
        Ok(HouseholdState {
            household_id: self.household_id,
            mode: self.mode,
            items: self.items.clone(),
            handoffs: self.handoffs.clone(),
            talks: self.talks.clone(),
            pulses,
            routines,
            areas: self.areas.clone(),
            notes: self.notes.clone(),
            pins,
            playbooks: self.playbooks.clone(),
            reference_records: self.reference_records.clone(),
            maintenance_events: self.maintenance_events.clone(),
            attachments: self.attachments.clone(),
            responsibilities: self.responsibilities.clone(),
        })
    }
}

pub(super) fn has_concurrent_archive(
    archives: Option<&BTreeSet<(u64, DeviceId)>>,
    event: &EventEnvelope,
) -> bool {
    archives.is_some_and(|archives| {
        archives.iter().any(|(logical_time, device_id)| {
            *logical_time == event.logical_time && *device_id != event.device_id
        })
    })
}

pub(super) fn is_concurrent_terminal_conflict(
    archived_by: Option<(u64, DeviceId)>,
    event: &EventEnvelope,
) -> bool {
    // Cross-device mutations at the archive's logical time cannot undo its terminal tombstone.
    archived_by.is_some_and(|(logical_time, device_id)| {
        logical_time == event.logical_time && device_id != event.device_id
    })
}
