use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::event::*;
use crate::protocol::{DecodedRequest, PROTOCOL_V22, PROTOCOL_V23};
use crate::recurrence::CivilDate;

fn context(n: u8, device: u8, logical: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([device; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(n),
        logical_time: logical,
    }
}
fn request(events: Vec<EventEnvelope>, version: u16) -> DecodedRequest {
    DecodedRequest {
        protocol_version: version,
        events,
        as_of: Some(1_791_475_200_100),
        summary_cursor: None,
        civil_date: Some(CivilDate::from_encoded(20261009).unwrap()),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn append(events: &mut Vec<EventEnvelope>, command: C, ctx: CommandContext) {
    events.push(
        execute(&command, ctx, request(events.clone(), PROTOCOL_V23))
            .unwrap()
            .event,
    );
}

#[test]
fn item_and_routine_responsibility_take_handoff_clear_and_replay() {
    let mut events = vec![];
    append(
        &mut events,
        C::AddItem {
            id: ItemId([4; 16]),
            text: "Pharmacy pickup".into(),
            classification: ItemClassification::Need,
        },
        context(1, 1, 1),
    );
    append(
        &mut events,
        C::CreateRoutine {
            id: RoutineId([5; 16]),
            text: "Water plants".into(),
            cadence: crate::recurrence::Cadence::Weekly,
            created_on: CivilDate::from_encoded(20261009).unwrap(),
        },
        context(2, 1, 2),
    );
    append(
        &mut events,
        C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: [4; 16],
            member_id: Some(ActorId([1; 16])),
        },
        context(3, 1, 3),
    );
    append(
        &mut events,
        C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Routine,
            target_id: [5; 16],
            member_id: Some(ActorId([2; 16])),
        },
        context(4, 2, 4),
    );
    append(
        &mut events,
        C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: [4; 16],
            member_id: None,
        },
        context(5, 2, 5),
    );
    let state = crate::state::rebuild_distributed_on(
        &events,
        1_791_475_200_100,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(
        state
            .responsibilities
            .iter()
            .find(|entry| entry.target_kind == ResponsibilityTargetKind::Item)
            .unwrap()
            .member_id,
        None
    );
    assert_eq!(
        state
            .responsibilities
            .iter()
            .find(|entry| entry.target_kind == ResponsibilityTargetKind::Routine)
            .unwrap()
            .member_id,
        Some(ActorId([2; 16]))
    );
    assert_eq!(
        execute(
            &C::ChangeResponsibility {
                target_kind: ResponsibilityTargetKind::Item,
                target_id: [4; 16],
                member_id: Some(ActorId([1; 16]))
            },
            context(6, 2, 6),
            request(events.clone(), PROTOCOL_V22)
        )
        .unwrap_err(),
        crate::error::KinError::UnsupportedVersion
    );
}

#[test]
fn responsibility_concurrent_assignments_converge_by_event_order_and_archive_rejects_commands() {
    let mut base = vec![];
    append(
        &mut base,
        C::AddItem {
            id: ItemId([9; 16]),
            text: "Bins".into(),
            classification: ItemClassification::Need,
        },
        context(1, 1, 1),
    );
    let a = execute(
        &C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: [9; 16],
            member_id: Some(ActorId([1; 16])),
        },
        context(2, 1, 2),
        request(base.clone(), PROTOCOL_V23),
    )
    .unwrap()
    .event;
    let b = execute(
        &C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: [9; 16],
            member_id: Some(ActorId([2; 16])),
        },
        context(3, 2, 2),
        request(base.clone(), PROTOCOL_V23),
    )
    .unwrap()
    .event;
    let forward = crate::state::rebuild_distributed_on(
        &[base[0].clone(), a.clone(), b.clone()],
        1_791_475_200_100,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    let reverse = crate::state::rebuild_distributed_on(
        &[base[0].clone(), b, a],
        1_791_475_200_100,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(forward.responsibilities, reverse.responsibilities);
    let mut archived = base;
    append(
        &mut archived,
        C::ArchiveItem(ItemId([9; 16])),
        context(4, 1, 2),
    );
    assert!(execute(
        &C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: [9; 16],
            member_id: Some(ActorId([1; 16]))
        },
        context(5, 1, 3),
        request(archived, PROTOCOL_V23)
    )
    .is_err());
}
