// Recurring tasks are Routines. These tests pin the protocol-24 Weekdays
// cadence, the derived next occurrence, and the occurrence-level completion
// invariants the Daily UX relies on, through the same command and replay
// paths the browser uses.
use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::core::encode_projection;
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{DecodedRequest, PROTOCOL_V23, PROTOCOL_V24};
use crate::recurrence::{Cadence, CivilDate};
use crate::state::{rebuild_distributed_on, HouseholdState};

const ROUTINE: RoutineId = RoutineId([5; 16]);
const AS_OF: i64 = 1_791_475_200_100;

fn day(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn context(n: u8, device: u8, logical: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_mul(7).wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([device; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(n),
        logical_time: logical,
    }
}

fn request(events: &[EventEnvelope], version: u16, on: u32) -> DecodedRequest {
    DecodedRequest {
        protocol_version: version,
        events: events.to_vec(),
        as_of: Some(AS_OF),
        summary_cursor: None,
        civil_date: Some(day(on)),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn run(
    events: &[EventEnvelope],
    command: C,
    ctx: CommandContext,
    on: u32,
) -> Result<EventEnvelope, KinError> {
    execute(&command, ctx, request(events, PROTOCOL_V24, on)).map(|result| result.event)
}

fn project(events: &[EventEnvelope], on: u32) -> HouseholdState {
    rebuild_distributed_on(events, AS_OF, day(on)).unwrap()
}

fn create(cadence: Cadence, on: u32) -> Vec<EventEnvelope> {
    vec![run(
        &[],
        C::CreateRoutine {
            id: ROUTINE,
            text: "Pack lunches".into(),
            cadence,
            created_on: day(on),
        },
        context(1, 1, 1),
        on,
    )
    .unwrap()]
}

fn complete(key: u32) -> C {
    C::CompleteOccurrence {
        id: ROUTINE,
        key: day(key),
    }
}

fn reopen(key: u32) -> C {
    C::ReopenOccurrence {
        id: ROUTINE,
        key: day(key),
    }
}

#[test]
fn weekdays_requires_protocol_24_end_to_end() {
    let command = C::CreateRoutine {
        id: ROUTINE,
        text: "Pack lunches".into(),
        cadence: Cadence::Weekdays,
        created_on: day(20261012),
    };
    assert_eq!(
        execute(
            &command,
            context(1, 1, 1),
            request(&[], PROTOCOL_V23, 20261012)
        )
        .unwrap_err(),
        KinError::UnsupportedVersion
    );
    let events = create(Cadence::Weekdays, 20261012);
    let state = project(&events, 20261012);
    let encoded_v23 = encode_projection(&request(&events, PROTOCOL_V23, 20261012), &state);
    assert_eq!(encoded_v23, Err(KinError::UnsupportedVersion));
    // An older protocol cannot decode a Weekdays event at all.
    let bytes = crate::codec::encode_event(&events[0]).unwrap();
    assert_eq!(
        crate::protocol::decode_event(&bytes, PROTOCOL_V23).unwrap_err(),
        KinError::UnsupportedVersion
    );
    assert_eq!(
        crate::protocol::decode_event(&bytes, PROTOCOL_V24).unwrap(),
        events[0]
    );
}

#[test]
fn protocol_24_appends_one_next_occurrence_per_routine() {
    let events = create(Cadence::Daily, 20261012);
    let state = project(&events, 20261012);
    assert_eq!(state.routines[0].next_start, Some(day(20261013)));
    let v23 = encode_projection(&request(&events, PROTOCOL_V23, 20261012), &state).unwrap();
    let v24 = encode_projection(&request(&events, PROTOCOL_V24, 20261012), &state).unwrap();
    assert_eq!(u16::from_le_bytes([v24[4], v24[5]]), 24);
    assert_eq!(v24.len(), v23.len() + 4);
    // Apart from the version, protocol 24 inserts exactly one u32 per
    // Routine (before the catch-up summary) and changes nothing else.
    assert_eq!(&v24[..4], &v23[..4]);
    assert_eq!(&v24[6..96], &v23[6..96]);
    let split = (96..v23.len())
        .find(|&index| v23[index] != v24[index])
        .unwrap_or(v23.len());
    assert_eq!(&v24[96..split], &v23[96..split]);
    assert_eq!(&v24[split..split + 4], &20261013u32.to_le_bytes());
    assert_eq!(&v24[split + 4..], &v23[split..]);
}

#[test]
fn weekday_task_is_due_monday_to_friday_and_absent_at_the_weekend() {
    let mut events = create(Cadence::Weekdays, 20261009); // Friday
    let friday = project(&events, 20261009);
    assert_eq!(friday.routines[0].occurrence_key, Some(day(20261009)));
    assert_eq!(friday.routines[0].next_start, Some(day(20261012)));
    for weekend in [20261010, 20261011] {
        let state = project(&events, weekend);
        assert_eq!(state.routines[0].occurrence_key, None);
        assert_eq!(state.routines[0].next_start, Some(day(20261012)));
        // Nothing to complete at the weekend, not even Friday's occurrence.
        assert_eq!(
            run(&events, complete(20261009), context(2, 1, 2), weekend).unwrap_err(),
            KinError::InvalidEvent
        );
        assert_eq!(
            run(&events, complete(weekend), context(2, 1, 2), weekend).unwrap_err(),
            KinError::InvalidEvent
        );
    }
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    assert!(project(&events, 20261012).routines[0].completed);
    assert!(!project(&events, 20261013).routines[0].completed);
}

#[test]
fn completing_the_current_occurrence_leaves_history_and_future_independent() {
    let mut events = create(Cadence::Daily, 20261012);
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    // Tomorrow is a separate, open occurrence; today's completion is history.
    let tomorrow = project(&events, 20261013);
    assert_eq!(tomorrow.routines[0].occurrence_key, Some(day(20261013)));
    assert!(!tomorrow.routines[0].completed);
    events.push(run(&events, complete(20261013), context(3, 1, 3), 20261013).unwrap());
    events.push(run(&events, reopen(20261013), context(4, 1, 4), 20261013).unwrap());
    assert!(project(&events, 20261012).routines[0].completed);
    assert!(!project(&events, 20261013).routines[0].completed);
    // Only one Routine ever exists: occurrences are keys, not copies.
    assert_eq!(project(&events, 20261020).routines.len(), 1);
}

#[test]
fn stale_or_repeated_occurrence_commands_are_rejected() {
    let mut events = create(Cadence::Daily, 20261012);
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    // A second completion of the same occurrence (another tab, a retry, a
    // replayed undo) changes nothing and is refused.
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
    // Yesterday's occurrence cannot be completed or reopened from a stale view.
    assert_eq!(
        run(&events, reopen(20261012), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
    // A future occurrence cannot be completed early.
    assert_eq!(
        run(&events, complete(20261013), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
    // Reopening an open occurrence is refused too.
    assert_eq!(
        run(&events, reopen(20261013), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn synchronized_duplicates_and_concurrent_completions_converge_on_one_occurrence() {
    let base = create(Cadence::Weekly, 20261012);
    // Two devices each complete the same week's occurrence before syncing.
    let mine = run(&base, complete(20261012), context(2, 1, 2), 20261014).unwrap();
    let theirs = run(&base, complete(20261012), context(2, 2, 2), 20261014).unwrap();
    assert_ne!(mine.event_id, theirs.event_id);
    let mut merged = base.clone();
    merged.extend([mine.clone(), theirs, mine]);
    let state = project(&merged, 20261014);
    assert_eq!(state.routines.len(), 1);
    assert!(state.routines[0].completed);
    assert_eq!(state.routines[0].next_start, Some(day(20261019)));
    // Next week is untouched by either completion.
    assert!(!project(&merged, 20261019).routines[0].completed);
    // A device that has seen the merge cannot complete it a third time.
    assert_eq!(
        run(&merged, complete(20261012), context(3, 1, 3), 20261014).unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn stopping_repetition_keeps_completed_history_and_blocks_new_occurrences() {
    let mut events = create(Cadence::Monthly, 20261012);
    events.push(run(&events, complete(20261001), context(2, 1, 2), 20261012).unwrap());
    events.push(
        run(
            &events,
            C::ArchiveRoutine(ROUTINE),
            context(3, 1, 3),
            20261012,
        )
        .unwrap(),
    );
    let state = project(&events, 20261012);
    assert!(state.routines[0].archived);
    assert_eq!(state.routines[0].occurrence_key, None);
    assert_eq!(state.routines[0].next_start, None);
    // History replays unchanged; nothing new can be recorded.
    assert_eq!(project(&events, 20261101).routines[0].next_start, None);
    for command in [complete(20261101), reopen(20261001)] {
        assert_eq!(
            run(&events, command, context(4, 1, 4), 20261101).unwrap_err(),
            KinError::InvalidEvent
        );
    }
    assert_eq!(
        run(
            &events,
            C::ArchiveRoutine(ROUTINE),
            context(4, 1, 4),
            20261101
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn paused_household_mode_rejects_occurrence_changes() {
    let mut events = create(Cadence::Weekdays, 20261012);
    events.push(
        run(
            &events,
            C::SetHouseholdMode(HouseholdMode::Vacation),
            context(2, 1, 2),
            20261012,
        )
        .unwrap(),
    );
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
}
