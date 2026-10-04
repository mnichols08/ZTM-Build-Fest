use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{decode_event, DecodedRequest, PROTOCOL_V9};
use crate::state::{rebuild, MAX_AREAS, MAX_AREA_NAME_BYTES, MAX_AREA_NAME_CHARS};

fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        protocol_version: PROTOCOL_V9,
        events,
        as_of: Some(1_760_000_000_000),
        summary_cursor: None,
        civil_date: Some(crate::recurrence::CivilDate::from_encoded(20261004).unwrap()),
        target_household_id: None,
        identity_bindings: Vec::new(),
    }
}

fn context(n: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_760_000_000_000 + i64::from(n),
        logical_time,
    }
}

fn run(events: &mut Vec<EventEnvelope>, command: C, n: u8) -> Result<EventEnvelope, KinError> {
    let result = execute(
        &command,
        context(n, events.len() as u64 + 1),
        request(events.clone()),
    )?;
    events.push(result.event.clone());
    Ok(result.event)
}

#[test]
fn assigned_items_keep_area_identity_through_rename_and_archive() {
    let mut events = Vec::new();
    let area_id = AreaId([10; 16]);
    run(
        &mut events,
        C::CreateArea {
            id: area_id,
            name: "  Kitchen  ".into(),
        },
        1,
    )
    .unwrap();
    let item_id = ItemId([11; 16]);
    run(
        &mut events,
        C::AddItem {
            id: item_id,
            text: "Wipe counter".into(),
            classification: ItemClassification::Need,
        },
        2,
    )
    .unwrap();
    run(
        &mut events,
        C::ChangeItemArea {
            item_id,
            area_id: Some(area_id),
        },
        3,
    )
    .unwrap();
    run(
        &mut events,
        C::RenameArea {
            id: area_id,
            name: "Cooking area".into(),
        },
        4,
    )
    .unwrap();
    run(&mut events, C::ArchiveArea(area_id), 5).unwrap();
    let state = rebuild(&events).unwrap();
    assert_eq!(state.areas[0].name, "Cooking area");
    assert!(state.areas[0].archived);
    assert_eq!(state.items[0].area_id, Some(area_id));
}

#[test]
fn unassigned_pre_area_history_needs_no_synthetic_area() {
    let request = request(Vec::new());
    assert!(request.events.is_empty());
    assert!(rebuild(&[]).unwrap().areas.is_empty());
}

#[test]
fn invalid_area_references_archived_assignment_and_archiving_rules_are_explicit() {
    let mut events = Vec::new();
    let area_id = AreaId([12; 16]);
    let item_id = ItemId([13; 16]);
    run(
        &mut events,
        C::CreateArea {
            id: area_id,
            name: "Home".into(),
        },
        1,
    )
    .unwrap();
    run(
        &mut events,
        C::AddItem {
            id: item_id,
            text: "Mail".into(),
            classification: ItemClassification::Need,
        },
        2,
    )
    .unwrap();
    run(&mut events, C::ArchiveArea(area_id), 3).unwrap();
    assert_eq!(
        execute(
            &C::ChangeItemArea {
                item_id,
                area_id: Some(area_id)
            },
            context(4, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        execute(
            &C::ChangeItemArea {
                item_id,
                area_id: Some(AreaId([99; 16]))
            },
            context(5, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        execute(
            &C::ArchiveArea(area_id),
            context(6, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let stale = crate::codec::encode_event(&EventEnvelope {
        event_id: EventId([7; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([4; 16]),
        timestamp: 1_760_000_000_007,
        logical_time: 4,
        event_version: 1,
        kind: EventKind::ItemAreaChanged {
            item_id,
            area_id: Some(area_id),
        },
        canonical_bytes: Vec::new(),
    })
    .unwrap();
    let stale_event = decode_event(&stale, PROTOCOL_V9).unwrap();
    events.push(stale_event);
    assert_eq!(rebuild(&events).unwrap().items[0].area_id, Some(area_id));
}

#[test]
fn names_are_trimmed_bounded_and_duplicate_commands_reject_without_merging() {
    assert_eq!(
        crate::state::normalize_area_name("  Garden  ").unwrap(),
        "Garden"
    );
    assert_eq!(
        crate::state::normalize_area_name("  "),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        crate::state::normalize_area_name(&"x".repeat(MAX_AREA_NAME_BYTES + 1)),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        crate::state::normalize_area_name(&"x".repeat(MAX_AREA_NAME_CHARS + 1)),
        Err(KinError::InvalidEvent)
    );
    let mut events = Vec::new();
    run(
        &mut events,
        C::CreateArea {
            id: AreaId([20; 16]),
            name: "Garden".into(),
        },
        1,
    )
    .unwrap();
    assert_eq!(
        execute(
            &C::CreateArea {
                id: AreaId([21; 16]),
                name: " garden ".into()
            },
            context(2, 2),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let duplicate = events[0].clone();
    let replay = rebuild(&[duplicate.clone(), duplicate]).unwrap();
    assert_eq!(replay.areas.len(), 1);
}

#[test]
fn area_creation_has_a_fixed_household_limit() {
    let mut events = Vec::new();
    for index in 0..MAX_AREAS {
        let byte = index as u8 + 1;
        run(
            &mut events,
            C::CreateArea {
                id: AreaId([byte; 16]),
                name: format!("Area {byte}"),
            },
            byte,
        )
        .unwrap();
    }
    let error = execute(
        &C::CreateArea {
            id: AreaId([200; 16]),
            name: "One more".into(),
        },
        context(201, MAX_AREAS as u64 + 1),
        request(events),
    )
    .unwrap_err();
    assert_eq!(error, KinError::InvalidEvent);
}
