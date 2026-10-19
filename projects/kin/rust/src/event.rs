use crate::recurrence::{Cadence, CivilDate};
use core::fmt;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(pub [u8; 16]);

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                for byte in self.0 {
                    write!(formatter, "{byte:02x}")?;
                }
                Ok(())
            }
        }
    };
}

id_type!(EventId);
id_type!(HouseholdId);
id_type!(ActorId);
id_type!(DeviceId);
id_type!(ItemId);
id_type!(HandoffId);
id_type!(TalkId);
id_type!(RoutineId);
id_type!(AreaId);
id_type!(NoteId);
id_type!(StepId);
id_type!(PlaybookId);
id_type!(ReferenceRecordId);
id_type!(ReferenceFieldId);
id_type!(MaintenanceEventId);
id_type!(AttachmentId);
id_type!(ChatMessageId);

/// What a chat message's content blob holds (#109).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ChatContentKind {
    Text = 1,
    Attachment = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum AttachmentParentKind {
    Note = 1,
    ReferenceRecord = 2,
    Maintenance = 3,
    Item = 4,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ResponsibilityTargetKind {
    Item = 1,
    Routine = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PinTargetKind {
    Item = 1,
    Note = 2,
    Routine = 3,
    Area = 4,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum HouseholdMode {
    #[default]
    Normal = 0,
    Vacation = 1,
    Guests = 2,
    Rest = 3,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct IdentityBinding {
    pub legacy_household_id: HouseholdId,
    pub legacy_actor_id: ActorId,
    pub legacy_device_id: DeviceId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemClassification {
    Today,
    Need,
    Shopping,
    Staple,
}

// Protocol identifiers, never scores or severity levels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PulseValue {
    Good = 0,
    Okay = 1,
    Drained = 2,
    RoughDay = 3,
    NeedQuiet = 4,
}

pub const MAX_TIMESTAMP: i64 = 8_640_000_000_000_000;
pub fn valid_timestamp(value: i64) -> bool {
    (-MAX_TIMESTAMP..=MAX_TIMESTAMP).contains(&value)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventKind {
    RoutineCreated {
        routine_id: RoutineId,
        text: String,
        cadence: Cadence,
        created_on: CivilDate,
    },
    RoutineOccurrenceCompleted {
        routine_id: RoutineId,
        key: CivilDate,
    },
    RoutineOccurrenceReopened {
        routine_id: RoutineId,
        key: CivilDate,
    },
    RoutineArchived {
        routine_id: RoutineId,
    },
    PulseSet {
        value: PulseValue,
        expires_at: i64,
    },
    PulseCleared,
    TalkAdded {
        talk_id: TalkId,
        text: String,
    },
    TalkResolved {
        talk_id: TalkId,
    },
    TalkReopened {
        talk_id: TalkId,
    },
    TalkArchived {
        talk_id: TalkId,
    },
    HandoffAdded {
        handoff_id: HandoffId,
        text: String,
    },
    HandoffAcknowledged {
        handoff_id: HandoffId,
    },
    HandoffArchived {
        handoff_id: HandoffId,
    },
    ItemAdded {
        item_id: ItemId,
        text: String,
        classification: ItemClassification,
    },
    ItemPlanningDateChanged {
        item_id: ItemId,
        planning_date: Option<CivilDate>,
    },
    ItemCompleted {
        item_id: ItemId,
    },
    ItemReopened {
        item_id: ItemId,
    },
    ItemArchived {
        item_id: ItemId,
    },
    AreaCreated {
        area_id: AreaId,
        name: String,
    },
    AreaRenamed {
        area_id: AreaId,
        name: String,
    },
    AreaArchived {
        area_id: AreaId,
    },
    ItemAreaChanged {
        item_id: ItemId,
        area_id: Option<AreaId>,
    },
    NoteCreated {
        note_id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    NoteUpdated {
        note_id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    NoteArchived {
        note_id: NoteId,
    },
    ItemStepAdded {
        item_id: ItemId,
        step_id: StepId,
        text: String,
    },
    ItemStepCompleted {
        item_id: ItemId,
        step_id: StepId,
    },
    ItemStepReopened {
        item_id: ItemId,
        step_id: StepId,
    },
    ItemStepArchived {
        item_id: ItemId,
        step_id: StepId,
    },
    HouseholdModeChanged {
        mode: HouseholdMode,
    },
    PinAdded {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    PinRemoved {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    PlaybookSaved {
        playbook_id: PlaybookId,
        title: String,
        entries: Vec<String>,
    },
    PlaybookArchived {
        playbook_id: PlaybookId,
    },
    ReferenceRecordSaved {
        record_id: ReferenceRecordId,
        title: String,
        area_id: Option<AreaId>,
        fields: Vec<(ReferenceFieldId, String, String)>,
    },
    ReferenceRecordArchived {
        record_id: ReferenceRecordId,
    },
    MaintenanceEventSaved {
        maintenance_id: MaintenanceEventId,
        record_id: ReferenceRecordId,
        performed_on: CivilDate,
        summary: String,
        next_on: Option<CivilDate>,
        routine_id: Option<RoutineId>,
    },
    MaintenanceEventArchived {
        maintenance_id: MaintenanceEventId,
    },
    AttachmentBound {
        attachment_id: AttachmentId,
        parent_kind: AttachmentParentKind,
        parent_id: [u8; 16],
    },
    AttachmentRemoved {
        attachment_id: AttachmentId,
    },
    ResponsibilityChanged {
        target_kind: ResponsibilityTargetKind,
        target_id: [u8; 16],
        member_id: Option<ActorId>,
    },
    /// A device announces its own automatic name ("Chrome on iPhone"). The
    /// device named is the event's header device; the name is canonical
    /// (`state::normalize_device_name`).
    DeviceDescribed {
        auto_name: String,
    },
    /// Sets (Some) or clears (None) a device's nickname. Only the member the
    /// device belongs to may name it (replay/devices.rs).
    DeviceNicknamed {
        device_id: DeviceId,
        nickname: Option<String>,
    },
    /// A chat message (#109). Its content is a blob outside the log: the
    /// 32-byte content hash and the blob's own 32-byte key (chat.rs).
    ChatMessagePosted {
        message_id: ChatMessageId,
        content_kind: ChatContentKind,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
    },
    /// The author replaces a message's content with a new blob.
    ChatMessageEdited {
        message_id: ChatMessageId,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
    },
    /// Deletes a message for everyone: by its author, or (`by_admin`) by a
    /// household admin.
    ChatMessageDeleted {
        message_id: ChatMessageId,
        by_admin: bool,
    },
    /// A member turns one emoji reaction to a message on or off (#127). The
    /// emoji is one grapheme (`chat::check_emoji`). The last write per
    /// (member, message, emoji) in replay order wins.
    ChatReactionSet {
        message_id: ChatMessageId,
        emoji: String,
        on: bool,
    },
}

impl EventKind {
    /// Chat events (#109) live in the chat log, never in the household log
    /// (history.rs): the two are replayed, capped and kept apart.
    pub const fn is_chat(&self) -> bool {
        matches!(
            self,
            EventKind::ChatMessagePosted { .. }
                | EventKind::ChatMessageEdited { .. }
                | EventKind::ChatMessageDeleted { .. }
                | EventKind::ChatReactionSet { .. }
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventEnvelope {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
    pub event_version: u16,
    pub kind: EventKind,
    pub canonical_bytes: Vec<u8>,
}
