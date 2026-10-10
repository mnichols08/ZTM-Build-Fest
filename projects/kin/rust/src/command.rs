//! Household intent validation. Browser capabilities supply identity, randomness
//! and time explicitly; authentication/pairing are separate adapter concerns.
use crate::codec::{encode_event, encode_metadata};
use crate::core::{encode_projection, project};
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{
    decode_event, decode_request_with_summary, DecodedRequest, MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES,
    PROTOCOL_VERSION,
};
use crate::recurrence::{Cadence, CivilDate};
use crate::state::{
    normalize_area_name, normalize_step_text, HouseholdState, ItemStatus, MAX_STEPS_PER_ITEM,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HouseholdCommand {
    AddItem {
        id: ItemId,
        text: String,
        classification: ItemClassification,
    },
    CompleteItem(ItemId),
    ReopenItem(ItemId),
    ArchiveItem(ItemId),
    AddItemStep {
        item_id: ItemId,
        step_id: StepId,
        text: String,
    },
    CompleteItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    ReopenItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    ArchiveItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    CaptureHandoff {
        id: HandoffId,
        text: String,
    },
    AcknowledgeHandoff(HandoffId),
    ArchiveHandoff(HandoffId),
    CaptureTalk {
        id: TalkId,
        text: String,
    },
    ResolveTalk(TalkId),
    ReopenTalk(TalkId),
    ArchiveTalk(TalkId),
    SetPulse {
        value: PulseValue,
        expires_at: i64,
    },
    ClearPulse,
    CreateRoutine {
        id: RoutineId,
        text: String,
        cadence: Cadence,
        created_on: CivilDate,
    },
    CompleteOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ReopenOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ArchiveRoutine(RoutineId),
    CreateArea {
        id: AreaId,
        name: String,
    },
    RenameArea {
        id: AreaId,
        name: String,
    },
    ArchiveArea(AreaId),
    ChangeItemArea {
        item_id: ItemId,
        area_id: Option<AreaId>,
    },
    CreateNote {
        id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    UpdateNote {
        id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    ArchiveNote(NoteId),
    SetHouseholdMode(HouseholdMode),
    SetItemPlanningDate {
        item_id: ItemId,
        planning_date: Option<CivilDate>,
    },
    Pin {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    Unpin {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    SavePlaybook {
        id: PlaybookId,
        title: String,
        entries: Vec<String>,
    },
    ArchivePlaybook(PlaybookId),
    SaveReferenceRecord {
        id: ReferenceRecordId,
        title: String,
        area_id: Option<AreaId>,
        fields: Vec<(ReferenceFieldId, String, String)>,
    },
    ArchiveReferenceRecord(ReferenceRecordId),
    SaveMaintenanceEvent {
        id: MaintenanceEventId,
        record_id: ReferenceRecordId,
        performed_on: CivilDate,
        summary: String,
        next_on: Option<CivilDate>,
        routine_id: Option<RoutineId>,
    },
    ArchiveMaintenanceEvent(MaintenanceEventId),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandContext {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
}

pub fn create_event(
    command: &HouseholdCommand,
    context: CommandContext,
) -> Result<EventEnvelope, KinError> {
    use HouseholdCommand::*;
    let kind = match command {
        AddItem {
            id,
            text,
            classification,
        } => EventKind::ItemAdded {
            item_id: *id,
            text: text.clone(),
            classification: *classification,
        },
        CompleteItem(id) => EventKind::ItemCompleted { item_id: *id },
        ReopenItem(id) => EventKind::ItemReopened { item_id: *id },
        ArchiveItem(id) => EventKind::ItemArchived { item_id: *id },
        AddItemStep {
            item_id,
            step_id,
            text,
        } => EventKind::ItemStepAdded {
            item_id: *item_id,
            step_id: *step_id,
            text: normalize_step_text(text)?,
        },
        CompleteItemStep { item_id, step_id } => EventKind::ItemStepCompleted {
            item_id: *item_id,
            step_id: *step_id,
        },
        ReopenItemStep { item_id, step_id } => EventKind::ItemStepReopened {
            item_id: *item_id,
            step_id: *step_id,
        },
        ArchiveItemStep { item_id, step_id } => EventKind::ItemStepArchived {
            item_id: *item_id,
            step_id: *step_id,
        },
        CaptureHandoff { id, text } => EventKind::HandoffAdded {
            handoff_id: *id,
            text: text.clone(),
        },
        AcknowledgeHandoff(id) => EventKind::HandoffAcknowledged { handoff_id: *id },
        ArchiveHandoff(id) => EventKind::HandoffArchived { handoff_id: *id },
        CaptureTalk { id, text } => EventKind::TalkAdded {
            talk_id: *id,
            text: text.clone(),
        },
        ResolveTalk(id) => EventKind::TalkResolved { talk_id: *id },
        ReopenTalk(id) => EventKind::TalkReopened { talk_id: *id },
        ArchiveTalk(id) => EventKind::TalkArchived { talk_id: *id },
        SetPulse { value, expires_at } => EventKind::PulseSet {
            value: *value,
            expires_at: *expires_at,
        },
        ClearPulse => EventKind::PulseCleared,
        CreateRoutine {
            id,
            text,
            cadence,
            created_on,
        } => EventKind::RoutineCreated {
            routine_id: *id,
            text: text.clone(),
            cadence: *cadence,
            created_on: *created_on,
        },
        CompleteOccurrence { id, key } => EventKind::RoutineOccurrenceCompleted {
            routine_id: *id,
            key: *key,
        },
        ReopenOccurrence { id, key } => EventKind::RoutineOccurrenceReopened {
            routine_id: *id,
            key: *key,
        },
        ArchiveRoutine(id) => EventKind::RoutineArchived { routine_id: *id },
        CreateArea { id, name } => EventKind::AreaCreated {
            area_id: *id,
            name: normalize_area_name(name)?,
        },
        RenameArea { id, name } => EventKind::AreaRenamed {
            area_id: *id,
            name: normalize_area_name(name)?,
        },
        ArchiveArea(id) => EventKind::AreaArchived { area_id: *id },
        ChangeItemArea { item_id, area_id } => EventKind::ItemAreaChanged {
            item_id: *item_id,
            area_id: *area_id,
        },
        CreateNote {
            id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = crate::state::normalize_note(title, body)?;
            EventKind::NoteCreated {
                note_id: *id,
                title,
                body,
                area_id: *area_id,
            }
        }
        UpdateNote {
            id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = crate::state::normalize_note(title, body)?;
            EventKind::NoteUpdated {
                note_id: *id,
                title,
                body,
                area_id: *area_id,
            }
        }
        ArchiveNote(id) => EventKind::NoteArchived { note_id: *id },
        SetHouseholdMode(mode) => EventKind::HouseholdModeChanged { mode: *mode },
        SetItemPlanningDate {
            item_id,
            planning_date,
        } => EventKind::ItemPlanningDateChanged {
            item_id: *item_id,
            planning_date: *planning_date,
        },
        Pin {
            target_kind,
            target_id,
        } => EventKind::PinAdded {
            target_kind: *target_kind,
            target_id: *target_id,
        },
        Unpin {
            target_kind,
            target_id,
        } => EventKind::PinRemoved {
            target_kind: *target_kind,
            target_id: *target_id,
        },
        SavePlaybook { id, title, entries } => EventKind::PlaybookSaved {
            playbook_id: *id,
            title: title.clone(),
            entries: entries.clone(),
        },
        ArchivePlaybook(id) => EventKind::PlaybookArchived { playbook_id: *id },
        SaveReferenceRecord {
            id,
            title,
            area_id,
            fields,
        } => EventKind::ReferenceRecordSaved {
            record_id: *id,
            title: title.clone(),
            area_id: *area_id,
            fields: fields.clone(),
        },
        ArchiveReferenceRecord(id) => EventKind::ReferenceRecordArchived { record_id: *id },
        SaveMaintenanceEvent {
            id,
            record_id,
            performed_on,
            summary,
            next_on,
            routine_id,
        } => EventKind::MaintenanceEventSaved {
            maintenance_id: *id,
            record_id: *record_id,
            performed_on: *performed_on,
            summary: summary.clone(),
            next_on: *next_on,
            routine_id: *routine_id,
        },
        ArchiveMaintenanceEvent(id) => EventKind::MaintenanceEventArchived {
            maintenance_id: *id,
        },
    };
    let event = EventEnvelope {
        event_id: context.event_id,
        household_id: context.household_id,
        actor_id: context.actor_id,
        device_id: context.device_id,
        timestamp: context.timestamp,
        logical_time: context.logical_time,
        event_version: if matches!(command, AddItem { .. }) {
            2
        } else {
            1
        },
        kind,
        canonical_bytes: Vec::new(),
    };
    decode_event(&encode_event(&event)?, PROTOCOL_VERSION)
}

#[derive(Debug)]
pub struct CommandResult {
    pub event: EventEnvelope,
    pub projection: HouseholdState,
    pub encoded_projection: Vec<u8>,
}

/// Full validation happens before the adapter persists anything. Historical
/// replay remains idempotent; a stale local Routine intent is rejected here.
pub fn execute(
    command: &HouseholdCommand,
    context: CommandContext,
    mut request: DecodedRequest,
) -> Result<CommandResult, KinError> {
    if request.events.len() >= MAX_EVENT_COUNT
        || !valid_timestamp(context.timestamp)
        || context.logical_time == 0
        || context.logical_time == u64::MAX
    {
        return Err(KinError::InvalidEvent);
    }
    if request
        .target_household_id
        .is_some_and(|household| household != context.household_id)
        || request.events.iter().any(|event| {
            event.household_id != context.household_id
                || event.logical_time >= context.logical_time
                || event.event_id == context.event_id
        })
    {
        return Err(KinError::InvalidEvent);
    }
    let current = project(&request)?;
    if matches!(
        command,
        HouseholdCommand::SavePlaybook { .. } | HouseholdCommand::ArchivePlaybook(_)
    ) && request.protocol_version < crate::protocol::PROTOCOL_V19
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::SaveReferenceRecord { .. } | HouseholdCommand::ArchiveReferenceRecord(_)
    ) && request.protocol_version < crate::protocol::PROTOCOL_V20
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::SaveMaintenanceEvent { .. }
            | HouseholdCommand::ArchiveMaintenanceEvent(_)
    ) && request.protocol_version < crate::protocol::PROTOCOL_V21
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::AddItemStep { .. }
            | HouseholdCommand::CompleteItemStep { .. }
            | HouseholdCommand::ReopenItemStep { .. }
            | HouseholdCommand::ArchiveItemStep { .. }
    ) && request.protocol_version < crate::protocol::PROTOCOL_V11
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::CreateRoutine {
            cadence: Cadence::Biweekly | Cadence::Monthly,
            ..
        }
    ) && request.protocol_version < crate::protocol::PROTOCOL_V12
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::AddItem {
            classification: ItemClassification::Staple,
            ..
        }
    ) && request.protocol_version < crate::protocol::PROTOCOL_V14
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(
        command,
        HouseholdCommand::AddItem {
            classification: ItemClassification::Shopping,
            ..
        }
    ) && request.protocol_version < crate::protocol::PROTOCOL_V13
    {
        return Err(KinError::UnsupportedVersion);
    }
    if matches!(command, HouseholdCommand::SetHouseholdMode(_))
        && request.protocol_version < crate::protocol::PROTOCOL_V15
    {
        return Err(KinError::UnsupportedVersion);
    }
    if let HouseholdCommand::SetHouseholdMode(mode) = command {
        if current.mode == *mode {
            return Err(KinError::InvalidEvent);
        }
    }
    if let HouseholdCommand::SetItemPlanningDate {
        item_id,
        planning_date,
    } = command
    {
        let item = current
            .items
            .iter()
            .find(|item| item.item_id == *item_id)
            .ok_or(KinError::InvalidEvent)?;
        if item.status == ItemStatus::Archived || item.planning_date == *planning_date {
            return Err(KinError::InvalidEvent);
        }
        if request.protocol_version < crate::protocol::PROTOCOL_V16 {
            return Err(KinError::UnsupportedVersion);
        }
    }
    let routine_intent = match command {
        HouseholdCommand::CompleteOccurrence { id, key } => Some((id, key, false)),
        HouseholdCommand::ReopenOccurrence { id, key } => Some((id, key, true)),
        _ => None,
    };
    if let Some((id, key, completed)) = routine_intent {
        let routine = current
            .routines
            .iter()
            .find(|r| r.routine_id == *id)
            .ok_or(KinError::InvalidEvent)?;
        if routine.archived
            || current.mode != HouseholdMode::Normal
            || routine.occurrence_key != Some(*key)
            || routine.completed != completed
        {
            return Err(KinError::InvalidEvent);
        }
    }
    match command {
        HouseholdCommand::AddItemStep {
            item_id,
            step_id,
            text,
        } => {
            normalize_step_text(text)?;
            let item = current
                .items
                .iter()
                .find(|item| item.item_id == *item_id)
                .ok_or(KinError::InvalidEvent)?;
            if item.status != ItemStatus::Active
                || item.steps.len() >= MAX_STEPS_PER_ITEM
                || step_id.0 == [0; 16]
                || current
                    .items
                    .iter()
                    .any(|item| item.steps.iter().any(|step| step.step_id == *step_id))
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CompleteItemStep { item_id, step_id }
        | HouseholdCommand::ReopenItemStep { item_id, step_id }
        | HouseholdCommand::ArchiveItemStep { item_id, step_id } => {
            let item = current
                .items
                .iter()
                .find(|item| item.item_id == *item_id && item.status == ItemStatus::Active)
                .ok_or(KinError::InvalidEvent)?;
            let step = item
                .steps
                .iter()
                .find(|step| step.step_id == *step_id && !step.archived)
                .ok_or(KinError::InvalidEvent)?;
            let valid_action = match command {
                HouseholdCommand::CompleteItemStep { .. } => !step.completed,
                HouseholdCommand::ReopenItemStep { .. } => step.completed,
                HouseholdCommand::ArchiveItemStep { .. } => true,
                _ => false,
            };
            if !valid_action {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CreateArea { id, name } | HouseholdCommand::RenameArea { id, name } => {
            let normalized = normalize_area_name(name)?;
            if current.areas.iter().any(|area| {
                area.area_id != *id && area.name.to_lowercase() == normalized.to_lowercase()
            }) {
                return Err(KinError::InvalidEvent);
            }
            if matches!(command, HouseholdCommand::RenameArea { .. })
                && !current
                    .areas
                    .iter()
                    .any(|area| area.area_id == *id && !area.archived)
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::ArchiveArea(id)
            if current
                .areas
                .iter()
                .any(|area| area.area_id == *id && area.archived) =>
        {
            return Err(KinError::InvalidEvent)
        }
        HouseholdCommand::ArchiveArea(id)
            if !current.areas.iter().any(|area| area.area_id == *id) =>
        {
            return Err(KinError::InvalidEvent)
        }
        HouseholdCommand::ChangeItemArea { item_id, area_id } => {
            current
                .items
                .iter()
                .find(|item| item.item_id == *item_id && item.status != ItemStatus::Archived)
                .ok_or(KinError::InvalidEvent)?;
            if area_id.is_some_and(|id| {
                !current
                    .areas
                    .iter()
                    .any(|area| area.area_id == id && !area.archived)
            }) {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CreateNote {
            id,
            title,
            body,
            area_id,
        } => {
            crate::state::normalize_note(title, body)?;
            if id.0 == [0; 16]
                || current.notes.len() >= crate::state::MAX_NOTES
                || current.notes.iter().any(|note| note.note_id == *id)
                || area_id.is_some_and(|area_id| {
                    !current
                        .areas
                        .iter()
                        .any(|area| area.area_id == area_id && !area.archived)
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::UpdateNote {
            id,
            title,
            body,
            area_id,
        } => {
            crate::state::normalize_note(title, body)?;
            if !current
                .notes
                .iter()
                .any(|note| note.note_id == *id && note.status == crate::state::NoteStatus::Active)
                || area_id.is_some_and(|area_id| {
                    !current
                        .areas
                        .iter()
                        .any(|area| area.area_id == area_id && !area.archived)
                        && !current
                            .notes
                            .iter()
                            .any(|note| note.note_id == *id && note.area_id == Some(area_id))
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::ArchiveNote(id)
            if !current.notes.iter().any(|note| {
                note.note_id == *id && note.status == crate::state::NoteStatus::Active
            }) =>
        {
            return Err(KinError::InvalidEvent)
        }
        _ => {}
    }
    if let HouseholdCommand::CreateRoutine { created_on, .. } = command {
        if request.civil_date != Some(*created_on) {
            return Err(KinError::InvalidEvent);
        }
    }
    let event = create_event(command, context)?;
    request.events.push(event.clone());
    let projection = project(&request)?;
    let encoded_projection = encode_projection(&request, &projection)?;
    Ok(CommandResult {
        event,
        projection,
        encoded_projection,
    })
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], KinError> {
    bytes
        .get(offset..offset + N)
        .ok_or(KinError::MalformedProtocol)?
        .try_into()
        .map_err(|_| KinError::MalformedProtocol)
}

/// KCMD v1 is an intent transport, independent of immutable event schemas.
pub fn decode_command(bytes: &[u8]) -> Result<(HouseholdCommand, CommandContext), KinError> {
    if bytes.len() < 128
        || bytes.len()
            > 128
                + 24
                + crate::state::MAX_NOTE_TITLE_BYTES
                + crate::state::MAX_NOTE_BODY_BYTES.max(16 + crate::state::MAX_STEP_TEXT_BYTES)
        || &bytes[..4] != b"KCMD"
    {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes(field(bytes, 4)?) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] || bytes[10..12] != [0; 2] || bytes[113..116] != [0; 3] {
        return Err(KinError::MalformedProtocol);
    }
    let kind = u16::from_le_bytes(field(bytes, 8)?);
    let id = field(bytes, 92)?;
    let date = u32::from_le_bytes(field(bytes, 108)?);
    let option = bytes[112];
    let expires = i64::from_le_bytes(field(bytes, 116)?);
    let text_length = u32::from_le_bytes(field(bytes, 124)?) as usize;
    if bytes.len() != 128 + text_length {
        return Err(KinError::MalformedProtocol);
    }
    let text = if matches!(kind, 21..=28 | 33 | 35 | 37) {
        String::new()
    } else {
        std::str::from_utf8(&bytes[128..])
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned()
    };
    let accepts_payload = matches!(kind, 1 | 5 | 8 | 14 | 18 | 19)
        || kind == 21 && text_length == 16
        || matches!(kind, 22 | 23) && text_length >= 24
        || kind == 25 && (17..=16 + crate::state::MAX_STEP_TEXT_BYTES).contains(&text_length);
    if !text.is_empty() && !accepts_payload
        || !matches!(kind, 14..=16 | 30) && date != 0
        || !matches!(kind, 1 | 12 | 14 | 29 | 31 | 32) && option != 0
        || kind != 12 && expires != 0
        || matches!(kind, 12 | 13 | 29) && id != [0; 16]
        || kind == 21 && text_length != 16
        || kind == 24 && text_length != 0
        || kind == 25 && !(17..=16 + crate::state::MAX_STEP_TEXT_BYTES).contains(&text_length)
        || matches!(kind, 26..=28) && text_length != 16
        || matches!(kind, 31 | 32 | 34 | 36) && text_length != 0
        || matches!(kind, 33..=38) && id == [0; 16]
        || kind == 37 && text_length < 42
        || kind == 38 && text_length != 0
    {
        return Err(KinError::MalformedProtocol);
    }
    use HouseholdCommand::*;
    let command = match kind {
        1 => AddItem {
            id: ItemId(id),
            text,
            classification: match option {
                0 => ItemClassification::Today,
                1 => ItemClassification::Need,
                2 => ItemClassification::Shopping,
                3 => ItemClassification::Staple,
                _ => return Err(KinError::MalformedProtocol),
            },
        },
        2 => CompleteItem(ItemId(id)),
        3 => ReopenItem(ItemId(id)),
        4 => ArchiveItem(ItemId(id)),
        25 if text_length >= 17 => {
            let item_id = ItemId(field(bytes, 128)?);
            let text = std::str::from_utf8(&bytes[144..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            AddItemStep {
                item_id,
                step_id: StepId(id),
                text,
            }
        }
        26..=28 if text_length == 16 => {
            let item_id = ItemId(field(bytes, 128)?);
            match kind {
                26 => CompleteItemStep {
                    item_id,
                    step_id: StepId(id),
                },
                27 => ReopenItemStep {
                    item_id,
                    step_id: StepId(id),
                },
                _ => ArchiveItemStep {
                    item_id,
                    step_id: StepId(id),
                },
            }
        }
        5 => CaptureHandoff {
            id: HandoffId(id),
            text,
        },
        6 => AcknowledgeHandoff(HandoffId(id)),
        7 => ArchiveHandoff(HandoffId(id)),
        8 => CaptureTalk {
            id: TalkId(id),
            text,
        },
        9 => ResolveTalk(TalkId(id)),
        10 => ReopenTalk(TalkId(id)),
        11 => ArchiveTalk(TalkId(id)),
        12 => SetPulse {
            value: match option {
                0 => PulseValue::Good,
                1 => PulseValue::Okay,
                2 => PulseValue::Drained,
                3 => PulseValue::RoughDay,
                4 => PulseValue::NeedQuiet,
                _ => return Err(KinError::MalformedProtocol),
            },
            expires_at: expires,
        },
        13 => ClearPulse,
        14 => CreateRoutine {
            id: RoutineId(id),
            text,
            cadence: Cadence::try_from(option)?,
            created_on: CivilDate::from_encoded(date)?,
        },
        15 => CompleteOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        16 => ReopenOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        17 => ArchiveRoutine(RoutineId(id)),
        18 => CreateArea {
            id: AreaId(id),
            name: text,
        },
        19 => RenameArea {
            id: AreaId(id),
            name: text,
        },
        20 => ArchiveArea(AreaId(id)),
        21 if text_length == 16 => {
            let area: [u8; 16] = bytes[128..144]
                .try_into()
                .map_err(|_| KinError::MalformedProtocol)?;
            ChangeItemArea {
                item_id: ItemId(id),
                area_id: (area != [0; 16]).then_some(AreaId(area)),
            }
        }
        22 | 23 if text_length >= 24 => {
            let title_len = u32::from_le_bytes(field(bytes, 128 + 16)?) as usize;
            let body_len = u32::from_le_bytes(field(bytes, 128 + 20)?) as usize;
            if 24usize
                .checked_add(title_len)
                .and_then(|v| v.checked_add(body_len))
                != Some(text_length)
            {
                return Err(KinError::MalformedProtocol);
            }
            let title = std::str::from_utf8(&bytes[152..152 + title_len])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            let body = std::str::from_utf8(&bytes[152 + title_len..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            let area: [u8; 16] = field(bytes, 128)?;
            let area_id = (area != [0; 16]).then_some(AreaId(area));
            if kind == 22 {
                CreateNote {
                    id: NoteId(id),
                    title,
                    body,
                    area_id,
                }
            } else {
                UpdateNote {
                    id: NoteId(id),
                    title,
                    body,
                    area_id,
                }
            }
        }
        24 if text_length == 0 => ArchiveNote(NoteId(id)),
        29 if text_length == 0 => SetHouseholdMode(match option {
            0 => HouseholdMode::Normal,
            1 => HouseholdMode::Vacation,
            2 => HouseholdMode::Guests,
            3 => HouseholdMode::Rest,
            _ => return Err(KinError::MalformedProtocol),
        }),
        30 if text_length == 0 => SetItemPlanningDate {
            item_id: ItemId(id),
            planning_date: (date != 0)
                .then(|| CivilDate::from_encoded(date))
                .transpose()?,
        },
        31 | 32 if text_length == 0 => {
            let target_kind = match option {
                1 => PinTargetKind::Item,
                2 => PinTargetKind::Note,
                3 => PinTargetKind::Routine,
                4 => PinTargetKind::Area,
                _ => return Err(KinError::MalformedProtocol),
            };
            if id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            if kind == 31 {
                Pin {
                    target_kind,
                    target_id: id,
                }
            } else {
                Unpin {
                    target_kind,
                    target_id: id,
                }
            }
        }
        33 if text_length >= 4 => {
            let payload = &bytes[128..];
            let title_len = u16::from_le_bytes(field(payload, 0)?) as usize;
            let count = payload[2] as usize;
            if payload[3] != 0 || count == 0 || count > crate::state::MAX_PLAYBOOK_ENTRIES {
                return Err(KinError::MalformedProtocol);
            }
            let title_end = 4usize
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(4..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            let mut offset = title_end;
            let mut entries = Vec::with_capacity(count);
            for _ in 0..count {
                let length = u16::from_le_bytes(field(payload, offset)?) as usize;
                offset += 2;
                let end = offset
                    .checked_add(length)
                    .ok_or(KinError::MalformedProtocol)?;
                entries.push(
                    std::str::from_utf8(
                        payload
                            .get(offset..end)
                            .ok_or(KinError::MalformedProtocol)?,
                    )
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned(),
                );
                offset = end;
            }
            if offset != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            SavePlaybook {
                id: PlaybookId(id),
                title,
                entries,
            }
        }
        34 if text_length == 0 => ArchivePlaybook(PlaybookId(id)),
        35 if text_length >= 58 => {
            let payload = &bytes[128..];
            let area = field(payload, 16)?;
            let title_len = u16::from_le_bytes(field(payload, 32)?) as usize;
            let count = payload[34] as usize;
            if payload[35] != 0 || count == 0 || count > crate::state::MAX_REFERENCE_FIELDS {
                return Err(KinError::MalformedProtocol);
            }
            let title_end = 36usize
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(36..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            let mut offset = title_end;
            let mut fields = Vec::with_capacity(count);
            for _ in 0..count {
                let field_id = ReferenceFieldId(field(payload, offset)?);
                let label_len = u16::from_le_bytes(field(payload, offset + 16)?) as usize;
                let value_len = u16::from_le_bytes(field(payload, offset + 18)?) as usize;
                offset += 20;
                let label_end = offset
                    .checked_add(label_len)
                    .ok_or(KinError::MalformedProtocol)?;
                let value_end = label_end
                    .checked_add(value_len)
                    .ok_or(KinError::MalformedProtocol)?;
                let label = std::str::from_utf8(
                    payload
                        .get(offset..label_end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                let value = std::str::from_utf8(
                    payload
                        .get(label_end..value_end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                fields.push((field_id, label, value));
                offset = value_end;
            }
            if offset != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            SaveReferenceRecord {
                id: ReferenceRecordId(id),
                title,
                area_id: (area != [0; 16]).then_some(AreaId(area)),
                fields,
            }
        }
        36 if text_length == 0 => ArchiveReferenceRecord(ReferenceRecordId(id)),
        37 if text_length >= 42 => {
            let payload = bytes.get(128..).ok_or(KinError::MalformedProtocol)?;
            if payload.len() != text_length {
                return Err(KinError::MalformedProtocol);
            }
            let record_id = ReferenceRecordId(field(payload, 0)?);
            let performed_on = CivilDate::from_encoded(u32::from_le_bytes(field(payload, 16)?))?;
            let next_raw = u32::from_le_bytes(field(payload, 20)?);
            let routine = field(payload, 24)?;
            let summary_len = u16::from_le_bytes(field(payload, 40)?) as usize;
            if summary_len == 0 || payload.len() != 42 + summary_len {
                return Err(KinError::MalformedProtocol);
            }
            let summary = std::str::from_utf8(&payload[42..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            SaveMaintenanceEvent {
                id: MaintenanceEventId(id),
                record_id,
                performed_on,
                summary,
                next_on: if next_raw == 0 {
                    None
                } else {
                    Some(CivilDate::from_encoded(next_raw)?)
                },
                routine_id: (routine != [0; 16]).then_some(RoutineId(routine)),
            }
        }
        38 if text_length == 0 => ArchiveMaintenanceEvent(MaintenanceEventId(id)),
        _ => return Err(KinError::UnsupportedVersion),
    };
    let context = CommandContext {
        event_id: EventId(field(bytes, 12)?),
        household_id: HouseholdId(field(bytes, 28)?),
        actor_id: ActorId(field(bytes, 44)?),
        device_id: DeviceId(field(bytes, 60)?),
        timestamp: i64::from_le_bytes(field(bytes, 76)?),
        logical_time: u64::from_le_bytes(field(bytes, 84)?),
    };
    Ok((command, context))
}

pub fn encode_command(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let (command, context) = decode_command(bytes)?;
    Ok(create_event(&command, context)?.canonical_bytes)
}

pub fn execute_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let request =
        decode_request_with_summary(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    let result = execute(&command, context, request)?;
    let metadata = encode_metadata(&result.event.canonical_bytes)?;
    let length =
        20 + result.event.canonical_bytes.len() + metadata.len() + result.encoded_projection.len();
    if length > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(b"KCMT\x01\0\0\0");
    output.extend_from_slice(&(result.event.canonical_bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&(result.encoded_projection.len() as u32).to_le_bytes());
    output.extend_from_slice(&result.event.canonical_bytes);
    output.extend_from_slice(&metadata);
    output.extend_from_slice(&result.encoded_projection);
    Ok(output)
}
