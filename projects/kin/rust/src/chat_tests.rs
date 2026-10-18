// Household chat (#109): CHAT_MESSAGE_POSTED (44), CHAT_MESSAGE_EDITED (45)
// and CHAT_MESSAGE_DELETED (46), their replay rules, the commands that create
// them, the KCHQ/KCHP page and the KCHT text arena. Wire records and expected
// page bytes are written out by hand; they never come from the encoders.
use crate::chat::*;
use crate::command::{
    decode_command, execute, execute_with, CommandContext, HeldHistory, HouseholdCommand as C,
};
use crate::core::{chat_page, replay_history};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::{decode_context, decode_request, DecodedRequest};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
/// Member 1 posts from device 0x11, member 2 from 0x21, member 3 (the admin
/// in these tests) from 0x31.
const MEMBER_1: [u8; 16] = [1; 16];
const MEMBER_2: [u8; 16] = [2; 16];
const ADMIN: [u8; 16] = [3; 16];
const BASE_TIME: i64 = 1_791_475_200_000;

fn record(kind: u16, event: u32, actor: [u8; 16], device: u8, payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[device; 16]);
    record.extend_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    record.extend_from_slice(&u64::from(event).to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

fn message(id: u8) -> [u8; 16] {
    [id; 16]
}

/// Blob refs and keys are distinct per (message, version).
fn blob(id: u8, version: u8) -> [u8; 32] {
    let mut bytes = [id; 32];
    bytes[31] = version;
    bytes
}

fn key(id: u8, version: u8) -> [u8; 32] {
    let mut bytes = [!id; 32];
    bytes[31] = version;
    bytes
}

fn posted(event: u32, actor: [u8; 16], device: u8, id: u8, kind: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[kind, 0, 0, 0]);
    payload.extend_from_slice(&blob(id, 0));
    payload.extend_from_slice(&key(id, 0));
    record(44, event, actor, device, &payload)
}

fn edited(event: u32, actor: [u8; 16], device: u8, id: u8, version: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&blob(id, version));
    payload.extend_from_slice(&key(id, version));
    record(45, event, actor, device, &payload)
}

fn deleted(event: u32, actor: [u8; 16], device: u8, id: u8, by_admin: bool) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[u8::from(by_admin), 0, 0, 0]);
    record(46, event, actor, device, &payload)
}

/// A chat log holding `records`, appended in the order given.
fn history_of(records: &[Vec<u8>]) -> History {
    let mut history = History::chat();
    history.append(&batch(records)).unwrap();
    history
}

fn batch(records: &[Vec<u8>]) -> Vec<u8> {
    let mut batch = (records.len() as u32).to_le_bytes().to_vec();
    for record in records {
        batch.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in records {
        batch.extend_from_slice(record);
    }
    batch
}

fn local_context() -> DecodedRequest {
    decode_context(&kine(&[], BASE_TIME + 100, TEST_DATE, None)).unwrap()
}

/// The chat state a replay of `records` leaves.
fn chat(records: &[Vec<u8>]) -> ChatState {
    let context = local_context();
    let state = history_of(records)
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    (*state.chat).clone()
}

fn status_of(state: &ChatState, id: u8) -> ChatMessageStatus {
    state.get(&ChatMessageId(message(id))).unwrap().status
}

#[test]
fn chat_records_decode_as_documented() {
    let event = decode_event(&posted(1, MEMBER_1, 0x11, 7, 1)).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatMessagePosted {
            message_id: ChatMessageId(message(7)),
            content_kind: ChatContentKind::Text,
            blob_ref: blob(7, 0),
            blob_key: key(7, 0),
        }
    );
    assert_eq!(event.canonical_bytes.len(), 88 + 84);
    assert_eq!(
        decode_event(&edited(2, MEMBER_1, 0x11, 7, 1)).unwrap().kind,
        EventKind::ChatMessageEdited {
            message_id: ChatMessageId(message(7)),
            blob_ref: blob(7, 1),
            blob_key: key(7, 1),
        }
    );
    assert_eq!(
        decode_event(&deleted(3, ADMIN, 0x31, 7, true))
            .unwrap()
            .kind,
        EventKind::ChatMessageDeleted {
            message_id: ChatMessageId(message(7)),
            by_admin: true,
        }
    );
    assert_eq!(
        decode_event(&posted(1, MEMBER_1, 0x11, 7, 2)).unwrap().kind,
        EventKind::ChatMessagePosted {
            message_id: ChatMessageId(message(7)),
            content_kind: ChatContentKind::Attachment,
            blob_ref: blob(7, 0),
            blob_key: key(7, 0),
        }
    );
}

#[test]
fn malformed_chat_records_are_rejected() {
    let good_post = posted(1, MEMBER_1, 0x11, 7, 1);
    let good_edit = edited(2, MEMBER_1, 0x11, 7, 1);
    let good_delete = deleted(3, MEMBER_1, 0x11, 7, false);
    let mut bad = Vec::new();
    // Zero message ID, unknown content kind, reserved bytes, zero ref, zero key.
    for (offset, value) in [(88, 0u8), (104, 0), (104, 3), (105, 1), (107, 1)] {
        let mut record = good_post.clone();
        if offset == 88 {
            record[88..104].fill(0);
        } else {
            record[offset] = value;
        }
        bad.push(record);
    }
    let mut zero_ref = good_post.clone();
    zero_ref[108..140].fill(0);
    bad.push(zero_ref);
    let mut zero_key = good_post.clone();
    zero_key[140..172].fill(0);
    bad.push(zero_key);
    let mut zero_edit_ref = good_edit.clone();
    zero_edit_ref[104..136].fill(0);
    bad.push(zero_edit_ref);
    let mut zero_edit_key = good_edit.clone();
    zero_edit_key[136..168].fill(0);
    bad.push(zero_edit_key);
    // by_admin must be 0 or 1; the rest reserved.
    for (offset, value) in [(104, 2u8), (105, 1), (107, 1)] {
        let mut record = good_delete.clone();
        record[offset] = value;
        bad.push(record);
    }
    // Truncated and overlong payloads.
    for good in [&good_post, &good_edit, &good_delete] {
        let mut short = good[..good.len() - 1].to_vec();
        let length = (short.len() - 88) as u32;
        short[84..88].copy_from_slice(&length.to_le_bytes());
        bad.push(short);
        let mut long = good.to_vec();
        long.push(0);
        let length = (long.len() - 88) as u32;
        long[84..88].copy_from_slice(&length.to_le_bytes());
        bad.push(long);
    }
    for record in bad {
        assert!(decode_event(&record).is_err(), "{:?}", &record[84..]);
    }
    // Chat is schema 1 only.
    let mut schema_2 = good_post;
    schema_2[..2].copy_from_slice(&2u16.to_le_bytes());
    assert_eq!(decode_event(&schema_2), Err(KinError::UnsupportedVersion));
}

#[test]
fn a_message_is_posted_edited_and_deleted() {
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        edited(4, MEMBER_1, 0x12, 1, 2),
        deleted(5, MEMBER_2, 0x21, 2, false),
    ];
    let state = chat(&records);
    assert_eq!(state.messages.len(), 2);
    assert_eq!(
        state.messages[0],
        ChatMessage {
            message_id: ChatMessageId(message(1)),
            author: ActorId(MEMBER_1),
            device: DeviceId([0x11; 16]),
            posted_at: BASE_TIME + 1,
            edited_at: BASE_TIME + 4,
            status: ChatMessageStatus::Edited,
            content_kind: ChatContentKind::Text,
            blob_ref: blob(1, 2),
            blob_key: key(1, 2),
        }
    );
    let second = &state.messages[1];
    assert_eq!(second.status, ChatMessageStatus::Deleted);
    assert_eq!((second.blob_ref, second.blob_key), ([0; 32], [0; 32]));
    // Every replaced or deleted blob is retired, in replay order.
    assert_eq!(state.retired, vec![blob(1, 0), blob(1, 1), blob(2, 0)]);
    assert!(state.admin_claims.is_empty());
}

#[test]
fn conflicting_chat_events_are_kept_and_change_nothing() {
    let base = posted(1, MEMBER_1, 0x11, 1, 1);
    let attachment = posted(2, MEMBER_1, 0x11, 2, 2);
    let expected = chat(&[base.clone(), attachment.clone()]);
    for conflicting in [
        // A second post of the same ID, even by the author: the first wins.
        posted(3, MEMBER_2, 0x21, 1, 1),
        posted(3, MEMBER_1, 0x11, 1, 2),
        // Another member edits it.
        edited(3, MEMBER_2, 0x21, 1, 1),
        // An edit that keeps the blob.
        edited(3, MEMBER_1, 0x11, 1, 0),
        // An attachment is never edited.
        edited(3, MEMBER_1, 0x11, 2, 1),
        // Messages this history never saw.
        edited(3, MEMBER_1, 0x11, 9, 1),
        deleted(3, MEMBER_1, 0x11, 9, false),
        deleted(3, ADMIN, 0x31, 9, true),
        // Another member deletes it without claiming to be an admin.
        deleted(3, MEMBER_2, 0x21, 1, false),
    ] {
        assert_eq!(
            chat(&[base.clone(), attachment.clone(), conflicting.clone()]),
            expected,
            "{:?}",
            decode_event(&conflicting).unwrap().kind
        );
    }
    // Nothing happens to a deleted message.
    let gone = [base.clone(), deleted(2, MEMBER_1, 0x11, 1, false)];
    let expected = chat(&gone);
    for after in [
        edited(3, MEMBER_1, 0x11, 1, 1),
        deleted(3, MEMBER_1, 0x11, 1, false),
        deleted(3, ADMIN, 0x31, 1, true),
    ] {
        let mut records = gone.to_vec();
        records.push(after);
        assert_eq!(chat(&records), expected);
    }
}

#[test]
fn a_delete_wins_over_a_concurrent_edit_in_either_replay_order() {
    // Same logical time from two devices of the author: replay orders them
    // by device ID, so each order is reached by swapping the devices.
    for (edit_device, delete_device) in [(0x11, 0x12), (0x12, 0x11)] {
        let mut edit = edited(2, MEMBER_1, edit_device, 1, 1);
        let mut delete = deleted(2, MEMBER_1, delete_device, 1, false);
        edit[4..20].copy_from_slice(&numbered_id(20));
        delete[4..20].copy_from_slice(&numbered_id(21));
        let state = chat(&[posted(1, MEMBER_1, 0x11, 1, 1), edit, delete]);
        assert_eq!(status_of(&state, 1), ChatMessageStatus::Deleted);
        let message = state.get(&ChatMessageId(message(1))).unwrap();
        assert_eq!(message.blob_ref, [0; 32]);
        // Both blobs the message ever had are retired; neither survives.
        let mut retired = state.retired.clone();
        retired.sort();
        let mut both = if edit_device < delete_device {
            vec![blob(1, 0), blob(1, 1)]
        } else {
            vec![blob(1, 0)]
        };
        both.sort();
        assert_eq!(retired, both);
    }
}

#[test]
fn replay_is_deterministic_in_any_input_order() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        deleted(4, ADMIN, 0x31, 2, true),
        posted(5, MEMBER_2, 0x21, 3, 2),
        deleted(6, MEMBER_1, 0x11, 1, false),
    ];
    let expected = chat(&records);
    let mut reversed = records.clone();
    reversed.reverse();
    assert_eq!(chat(&reversed), expected);
    let mut rotated = records.clone();
    rotated.rotate_left(2);
    assert_eq!(chat(&rotated), expected);
}

#[test]
fn an_admin_removal_counts_only_while_its_claimant_is_named_an_admin() {
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        deleted(2, ADMIN, 0x31, 1, true),
        // A second claim by the same admin is kept once.
        deleted(3, ADMIN, 0x32, 1, true),
        deleted(4, MEMBER_2, 0x21, 1, true),
    ];
    let state = chat(&records);
    let id = ChatMessageId(message(1));
    assert_eq!(
        state.admin_claims[&id],
        vec![ActorId(ADMIN), ActorId(MEMBER_2)]
    );
    // Replay leaves the message live; the page decides.
    assert_eq!(status_of(&state, 1), ChatMessageStatus::Live);
    assert!(state.removed_by_admin(&id, &[ActorId(ADMIN)]));
    assert!(state.removed_by_admin(&id, &[ActorId([9; 16]), ActorId(MEMBER_2)]));
    assert!(!state.removed_by_admin(&id, &[ActorId(MEMBER_1)]));
    assert!(!state.removed_by_admin(&id, &[]));
    assert!(
        state.retired.is_empty(),
        "retired at page time, not in replay"
    );
}

#[test]
fn the_household_history_and_the_chat_log_refuse_each_others_events() {
    let item = item_record(1, 1, b"Milk", 0);
    let post = posted(2, MEMBER_1, 0x11, 1, 1);
    let mut household = History::new();
    assert_eq!(
        household.append(&batch(&[item.clone(), post.clone()])),
        Err(KinError::InvalidEvent)
    );
    assert!(household.is_empty(), "nothing of a refused batch is kept");
    household
        .append(&batch(std::slice::from_ref(&item)))
        .unwrap();
    let mut chat_log = History::chat();
    assert_eq!(
        chat_log.append(&batch(std::slice::from_ref(&item))),
        Err(KinError::InvalidEvent)
    );
    chat_log
        .append(&batch(std::slice::from_ref(&post)))
        .unwrap();
    // A whole household request refuses chat events too.
    assert_eq!(
        decode_request(&kine(&[item, post], 0, TEST_DATE, None)).unwrap_err(),
        KinError::InvalidEvent
    );
    // Each log has its own cap.
    assert_eq!(household.limit(), crate::wire::MAX_EVENT_COUNT);
    assert_eq!(chat_log.limit(), MAX_CHAT_EVENT_COUNT);
    const { assert!(MAX_CHAT_EVENT_COUNT > 2 * 100_000) };
}

// Commands.

fn context(event: u8, actor: [u8; 16], device: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([event; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
        device_id: DeviceId([device; 16]),
        timestamp: BASE_TIME,
        logical_time,
    }
}

/// Runs a command against the chat log and, when it succeeds, appends the
/// new event as the host would once stored.
fn run(log: &mut History, command: C, ctx: CommandContext) -> Result<(), KinError> {
    let result = execute_with(&command, ctx, &mut HeldHistory::new(log, local_context())?)?;
    assert!(
        result.encoded_projection.is_empty(),
        "a chat command has no projection"
    );
    log.append(&batch(&[result.event.canonical_bytes])).unwrap();
    Ok(())
}

fn post(id: u8, content_kind: ChatContentKind) -> C {
    C::PostChatMessage {
        id: ChatMessageId(message(id)),
        content_kind,
        blob_ref: blob(id, 0),
        blob_key: key(id, 0),
    }
}

fn edit(id: u8, version: u8) -> C {
    C::EditChatMessage {
        id: ChatMessageId(message(id)),
        blob_ref: blob(id, version),
        blob_key: key(id, version),
    }
}

fn delete(id: u8, by_admin: bool) -> C {
    C::DeleteChatMessage {
        id: ChatMessageId(message(id)),
        by_admin,
    }
}

#[test]
fn commands_post_edit_and_delete_and_reject_what_replay_would_ignore() {
    let mut events = History::chat();
    run(
        &mut events,
        post(1, ChatContentKind::Text),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    run(
        &mut events,
        post(2, ChatContentKind::Attachment),
        context(2, MEMBER_2, 0x21, 2),
    )
    .unwrap();
    let rejected = [
        post(1, ChatContentKind::Text),
        edit(1, 0),
        edit(2, 1),
        edit(9, 1),
        delete(9, false),
        // Your own message is deleted as yourself, someone else's as admin.
        delete(1, true),
        delete(2, false),
    ];
    for command in rejected {
        assert_eq!(
            run(&mut events, command.clone(), context(3, MEMBER_1, 0x11, 3)),
            Err(KinError::InvalidEvent),
            "{command:?}"
        );
    }
    // Zero IDs, refs and keys are not events at all.
    for (id, blob_ref, blob_key) in [
        (message(3), [0; 32], key(3, 0)),
        (message(3), blob(3, 0), [0; 32]),
        ([0; 16], blob(3, 0), key(3, 0)),
    ] {
        let command = C::PostChatMessage {
            id: ChatMessageId(id),
            content_kind: ChatContentKind::Text,
            blob_ref,
            blob_key,
        };
        assert_eq!(
            run(&mut events, command, context(3, MEMBER_1, 0x11, 3)),
            Err(KinError::MalformedProtocol)
        );
    }
    assert_eq!(
        run(&mut events, edit(1, 1), context(3, MEMBER_2, 0x21, 3)),
        Err(KinError::InvalidEvent),
        "only the author edits"
    );
    run(&mut events, edit(1, 1), context(3, MEMBER_1, 0x12, 3)).unwrap();
    run(&mut events, delete(2, true), context(4, ADMIN, 0x31, 4)).unwrap();
    assert_eq!(
        run(&mut events, delete(2, true), context(5, ADMIN, 0x31, 5)),
        Err(KinError::InvalidEvent),
        "one claim per admin"
    );
    run(&mut events, delete(1, false), context(5, MEMBER_1, 0x11, 5)).unwrap();
    for command in [edit(1, 2), delete(1, false), delete(1, true)] {
        let actor = if matches!(command, C::DeleteChatMessage { by_admin: true, .. }) {
            ADMIN
        } else {
            MEMBER_1
        };
        assert_eq!(
            run(&mut events, command, context(6, actor, 0x11, 6)),
            Err(KinError::InvalidEvent)
        );
    }
    let context = local_context();
    let state = events
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    assert_eq!(status_of(&state.chat, 1), ChatMessageStatus::Deleted);
    assert!(state
        .chat
        .removed_by_admin(&ChatMessageId(message(2)), &[ActorId(ADMIN)]));
}

#[test]
fn chat_commands_run_against_the_chat_log_only() {
    let household_request = DecodedRequest {
        events: vec![],
        as_of: BASE_TIME + 100,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(TEST_DATE).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    };
    assert_eq!(
        execute(
            &post(1, ChatContentKind::Text),
            context(1, MEMBER_1, 0x11, 1),
            household_request
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let mut household = History::new();
    assert_eq!(
        execute_with(
            &post(1, ChatContentKind::Text),
            context(1, MEMBER_1, 0x11, 1),
            &mut HeldHistory::new(&mut household, local_context()).unwrap()
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let mut log = History::chat();
    assert_eq!(
        run(&mut log, C::ClearPulse, context(1, MEMBER_1, 0x11, 1)),
        Err(KinError::InvalidEvent)
    );
    // Through the kin_chat_execute layout.
    let mut intent = kcmd(44, message(1), 1, &[blob(1, 0), key(1, 0)].concat());
    intent[12..28].copy_from_slice(&[9; 16]);
    intent[28..44].copy_from_slice(&HOUSEHOLD);
    intent[44..60].copy_from_slice(&MEMBER_1);
    intent[60..76].copy_from_slice(&[0x11; 16]);
    intent[76..84].copy_from_slice(&BASE_TIME.to_le_bytes());
    let mut input = (intent.len() as u32).to_le_bytes().to_vec();
    input.extend_from_slice(&intent);
    input.extend_from_slice(&kine(&[], BASE_TIME + 100, TEST_DATE, None));
    let result = crate::command::execute_history(&input, &mut log).unwrap();
    assert_eq!(&result[..8], b"KCMT\x01\0\0\0");
    assert_eq!(u32_at(&result, 8), 88 + 84);
    assert_eq!(u32_at(&result, 16), 0, "no projection");
    assert!(log.is_empty(), "executing appends nothing");
}

fn kcmd(kind: u16, id: [u8; 16], option: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
    bytes[8..10].copy_from_slice(&kind.to_le_bytes());
    bytes[84..92].copy_from_slice(&1u64.to_le_bytes());
    bytes[92..108].copy_from_slice(&id);
    bytes[112] = option;
    bytes[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

#[test]
fn kcmd_carries_chat_commands() {
    let mut refs = blob(1, 0).to_vec();
    refs.extend_from_slice(&key(1, 0));
    assert_eq!(
        decode_command(&kcmd(44, message(1), 1, &refs)).unwrap().0,
        post(1, ChatContentKind::Text)
    );
    assert_eq!(
        decode_command(&kcmd(44, message(1), 2, &refs)).unwrap().0,
        post(1, ChatContentKind::Attachment)
    );
    let mut edit_refs = blob(1, 1).to_vec();
    edit_refs.extend_from_slice(&key(1, 1));
    assert_eq!(
        decode_command(&kcmd(45, message(1), 0, &edit_refs))
            .unwrap()
            .0,
        edit(1, 1)
    );
    assert_eq!(
        decode_command(&kcmd(46, message(1), 0, &[])).unwrap().0,
        delete(1, false)
    );
    assert_eq!(
        decode_command(&kcmd(46, message(1), 1, &[])).unwrap().0,
        delete(1, true)
    );
    for bytes in [
        kcmd(44, [0; 16], 1, &refs),
        kcmd(44, message(1), 0, &refs),
        kcmd(44, message(1), 3, &refs),
        kcmd(44, message(1), 1, &refs[..63]),
        kcmd(44, message(1), 1, &[refs.as_slice(), &[0]].concat()),
        kcmd(45, message(1), 1, &edit_refs),
        kcmd(45, [0; 16], 0, &edit_refs),
        kcmd(45, message(1), 0, &[]),
        kcmd(46, message(1), 2, &[]),
        kcmd(46, [0; 16], 0, &[]),
        kcmd(46, message(1), 0, &[0; 16]),
        kcmd(44, message(1), 1, &[[0; 32], key(1, 0)].concat()),
        kcmd(45, message(1), 0, &[blob(1, 1), [0; 32]].concat()),
    ] {
        assert_eq!(
            decode_command(&bytes).unwrap_err(),
            KinError::MalformedProtocol,
            "{:?}",
            &bytes[8..10]
        );
    }
    // A date or expiry is not part of a chat command.
    let mut dated = kcmd(46, message(1), 0, &[]);
    dated[108..112].copy_from_slice(&TEST_DATE.to_le_bytes());
    assert_eq!(
        decode_command(&dated).unwrap_err(),
        KinError::MalformedProtocol
    );
}

// Texts and pages.

#[test]
fn texts_are_checked() {
    for good in ["hi", "a\tb\nc", "🏠 home", &"é".repeat(MAX_CHAT_TEXT_CHARS)] {
        assert!(check_text(good.as_bytes()).is_ok(), "{good:?}");
    }
    for bad in [
        &b""[..],
        b" \n\t ",
        b"a\rb",
        b"\x00",
        b"a\x1bb",
        "\u{85}".as_bytes(),
        &[0xff, 0xfe],
    ] {
        assert_eq!(check_text(bad), Err(KinError::InvalidEvent), "{bad:?}");
    }
    let too_long = "a".repeat(MAX_CHAT_TEXT_CHARS + 1);
    assert_eq!(check_text(too_long.as_bytes()), Err(KinError::InvalidEvent));
}

fn kcht(entries: &[([u8; 32], &[u8])]) -> Vec<u8> {
    let mut bytes = b"KCHT\x01\0\0\0".to_vec();
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (blob_ref, text) in entries {
        bytes.extend_from_slice(blob_ref);
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text);
    }
    bytes
}

#[test]
fn the_text_arena_stores_each_text_alone_and_forgets_by_zeroing() {
    let mut texts = ChatTexts::new();
    let result = put_texts(
        &kcht(&[
            (blob(1, 0), b"Dinner at 6"),
            (blob(2, 0), b"\x07bell"),
            (blob(1, 0), b"ignored"),
        ]),
        &mut texts,
    )
    .unwrap();
    assert_eq!(result, b"KCHS\x01\0\0\0\x03\0\0\0\x00\x01\x00");
    // Content-addressed: the first text for a blob stays.
    assert_eq!(texts.get(&blob(1, 0)), Some(&b"Dinner at 6"[..]));
    assert_eq!(texts.get(&blob(2, 0)), None);
    assert_eq!(texts.len(), 1);
    // A malformed request stores nothing.
    let mut short = kcht(&[(blob(3, 0), b"ok"), (blob(4, 0), b"cut")]);
    short.pop();
    assert_eq!(
        put_texts(&short, &mut texts),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(texts.get(&blob(3, 0)), None);
    for bad in [
        kcht(&[]),
        kcht(&[([0; 32], b"zero ref")]),
        [kcht(&[(blob(3, 0), b"ok")]), vec![0]].concat(),
        b"KCHT\x02\0\0\0\x01\0\0\0".to_vec(),
    ] {
        assert!(put_texts(&bad, &mut texts).is_err());
    }
    texts.forget(&blob(1, 0));
    assert_eq!(texts.get(&blob(1, 0)), None);
    assert!(texts.is_empty());
    texts.clear();
}

fn kchq(before: u32, limit: u16, flags: u8, admins: &[[u8; 16]], context: &[u8]) -> Vec<u8> {
    let mut bytes = b"KCHQ\x01\0\0\0".to_vec();
    bytes.extend_from_slice(&before.to_le_bytes());
    bytes.extend_from_slice(&limit.to_le_bytes());
    bytes.push(flags);
    bytes.push(0);
    bytes.extend_from_slice(&(admins.len() as u32).to_le_bytes());
    for admin in admins {
        bytes.extend_from_slice(admin);
    }
    bytes.extend_from_slice(context);
    bytes
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[test]
fn the_kchp_page_is_laid_out_as_documented() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        posted(4, MEMBER_2, 0x21, 3, 2),
        deleted(5, ADMIN, 0x31, 3, true),
        posted(6, MEMBER_1, 0x11, 4, 1),
        deleted(7, MEMBER_1, 0x11, 4, false),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    put_texts(
        &kcht(&[
            (blob(1, 1), b"Edited"),
            (blob(2, 0), b"Hello"),
            (blob(1, 0), b"Old"),
            (blob(4, 0), b"Gone"),
        ]),
        &mut texts,
    )
    .unwrap();
    let context = kine(&[], 0, TEST_DATE, None);
    // The newest three, texts and retired blobs, with the admin named.
    let page = chat_page(
        &kchq(u32::MAX, 3, 0b11, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let mut expected = b"KCHP\x01\0\0\0".to_vec();
    for value in [4u32, 1, 3, 5, 3] {
        expected.extend_from_slice(&value.to_le_bytes());
    }
    let mut record = |id: u8,
                      author: [u8; 16],
                      device: u8,
                      posted: i64,
                      status: u8,
                      kind: u8,
                      blob_ref: [u8; 32],
                      text: (u32, u32)| {
        expected.extend_from_slice(&message(id));
        expected.extend_from_slice(&author);
        expected.extend_from_slice(&[device; 16]);
        expected.extend_from_slice(&(BASE_TIME + posted).to_le_bytes());
        expected.extend_from_slice(&0i64.to_le_bytes());
        expected.extend_from_slice(&u32::from(id - 1).to_le_bytes());
        expected.extend_from_slice(&[status, kind, 0, 0]);
        expected.extend_from_slice(&blob_ref);
        expected.extend_from_slice(&text.0.to_le_bytes());
        expected.extend_from_slice(&text.1.to_le_bytes());
        expected.extend_from_slice(&[0; 16]);
    };
    record(2, MEMBER_2, 0x21, 2, 0, 1, blob(2, 0), (0, 5));
    record(3, MEMBER_2, 0x21, 4, 3, 2, [0; 32], (0, 0));
    record(4, MEMBER_1, 0x11, 6, 2, 1, [0; 32], (0, 0));
    expected.extend_from_slice(&key(2, 0));
    expected.extend_from_slice(&[0; 64]);
    expected.extend_from_slice(b"Hello");
    for retired in [blob(1, 0), blob(4, 0), blob(3, 0)] {
        expected.extend_from_slice(&retired);
    }
    assert_eq!(page, expected);
    // Reading the page forgot the texts of retired blobs.
    assert_eq!(texts.get(&blob(1, 0)), None);
    assert_eq!(texts.get(&blob(4, 0)), None);
    assert_eq!(texts.get(&blob(1, 1)), Some(&b"Edited"[..]));

    // The page before it: message 1, edited, with its text at offset 0.
    let older = chat_page(
        &kchq(1, 50, 0b01, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(
        [u32_at(&older, 8), u32_at(&older, 12), u32_at(&older, 16)],
        [4, 0, 1]
    );
    assert_eq!(older[28 + 68], ChatMessageStatus::Edited as u8);
    assert_eq!(
        i64::from_le_bytes(older[28 + 56..28 + 64].try_into().unwrap()),
        BASE_TIME + 3
    );
    assert_eq!(&older[28 + 72..28 + 104], &blob(1, 1));
    assert_eq!(&older[older.len() - 6..], b"Edited");
    assert_eq!(u32_at(&older, 24), 0, "no retired list asked for");

    // Without the admin named, message 3 is live again (its blob and key
    // return) and nothing retires it.
    let unnamed = chat_page(
        &kchq(u32::MAX, 3, 0b10, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let second = 28 + 128;
    assert_eq!(unnamed[second + 68], ChatMessageStatus::Live as u8);
    assert_eq!(&unnamed[second + 72..second + 104], &blob(3, 0));
    assert_eq!(u32_at(&unnamed, 20), 0, "texts not asked for");
    assert_eq!(u32_at(&unnamed, 24), 2);
}

#[test]
fn malformed_page_requests_are_rejected() {
    let context = kine(&[], 0, TEST_DATE, None);
    let mut history = history_of(&[posted(1, MEMBER_1, 0x11, 1, 1)]);
    let mut texts = ChatTexts::new();
    let mut bad = vec![
        kchq(u32::MAX, 0, 0, &[], &context),
        kchq(u32::MAX, 501, 0, &[], &context),
        kchq(u32::MAX, 10, 0b100, &[], &context),
        kchq(u32::MAX, 10, 0, &[[0; 16]], &context),
        kchq(u32::MAX, 10, 0, &[[3; 16]; 17], &context),
        kchq(
            u32::MAX,
            10,
            0,
            &[],
            &kine(&[posted(1, MEMBER_1, 0x11, 1, 1)], 0, TEST_DATE, None),
        ),
        kchq(u32::MAX, 10, 0, &[], &[]),
    ];
    let mut reserved = kchq(u32::MAX, 10, 0, &[], &context);
    reserved[15] = 1;
    bad.push(reserved);
    let mut admins_past_end = kchq(u32::MAX, 10, 0, &[], &[]);
    admins_past_end[16] = 1;
    bad.push(admins_past_end);
    for request in bad {
        assert!(
            chat_page(&request, &mut history, &mut texts).is_err(),
            "{:?}",
            &request[..20]
        );
    }
    let mut version = kchq(u32::MAX, 10, 0, &[], &context);
    version[4] = 2;
    assert_eq!(
        chat_page(&version, &mut history, &mut texts),
        Err(KinError::UnsupportedVersion)
    );
    // An empty chat is an empty page.
    let mut empty = History::chat();
    let page = chat_page(
        &kchq(u32::MAX, 10, 0b11, &[], &context),
        &mut empty,
        &mut texts,
    )
    .unwrap();
    assert_eq!(
        page,
        b"KCHP\x01\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"
    );
    // The household projection never sees the chat.
    let mut household = History::new();
    household
        .append(&batch(&[item_record(1, 1, b"Milk", 0)]))
        .unwrap();
    assert!(replay_history(&context, &mut household).is_ok());
}

#[test]
fn identity_bindings_apply_to_chat_authors() {
    // A message written before the household was bound replays under the
    // bound member and device.
    let placeholder = [0x70; 16];
    let records = vec![posted(1, placeholder, 0x76, 1, 1)];
    let mut records = records;
    records[0][20..36].copy_from_slice(&[0x75; 16]);
    let binding = IdentityBinding {
        legacy_household_id: HouseholdId([0x75; 16]),
        legacy_actor_id: ActorId(placeholder),
        legacy_device_id: DeviceId([0x76; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(MEMBER_1),
        device_id: DeviceId([0x11; 16]),
    };
    let context = bound_kine(&[], 0, TEST_DATE, None, Some(HOUSEHOLD), &[binding]);
    let mut history = history_of(&records);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    assert_eq!(&page[28 + 16..28 + 32], &MEMBER_1);
    assert_eq!(&page[28 + 32..28 + 48], &[0x11; 16]);
}

#[test]
fn a_long_chat_replays_and_pages_quickly() {
    // 100,000 messages, one in ten edited and one in twenty deleted.
    const MESSAGES: u32 = 100_000;
    let mut records = Vec::with_capacity(MESSAGES as usize * 2);
    let mut event = 0u32;
    for index in 0..MESSAGES {
        let id = {
            let mut id = [0x40; 16];
            id[..4].copy_from_slice(&index.to_le_bytes());
            id
        };
        let mut reference = [0x50; 32];
        reference[..4].copy_from_slice(&index.to_le_bytes());
        event += 1;
        let mut payload = id.to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        payload.extend_from_slice(&reference);
        payload.extend_from_slice(&[0x60; 32]);
        records.push(record(44, event, MEMBER_1, 0x11, &payload));
        if index % 10 == 0 {
            event += 1;
            let mut payload = id.to_vec();
            reference[31] = 1;
            payload.extend_from_slice(&reference);
            payload.extend_from_slice(&[0x61; 32]);
            records.push(record(45, event, MEMBER_1, 0x11, &payload));
        }
        if index % 20 == 5 {
            event += 1;
            let mut payload = id.to_vec();
            payload.extend_from_slice(&[0, 0, 0, 0]);
            records.push(record(46, event, MEMBER_1, 0x11, &payload));
        }
    }
    let mut history = history_of(&records);
    let context = kine(&[], 0, TEST_DATE, None);
    let started = std::time::Instant::now();
    let page = chat_page(
        &kchq(u32::MAX, 50, 0b01, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    let first = started.elapsed();
    assert_eq!(u32_at(&page, 8), MESSAGES);
    assert_eq!(u32_at(&page, 16), 50);
    // A second page reuses the replay the history holds.
    let started = std::time::Instant::now();
    chat_page(
        &kchq(MESSAGES - 50, 50, 0, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    let second = started.elapsed();
    // Generous bounds for unoptimized test builds on shared CI machines.
    assert!(first.as_secs() < 20, "first page took {first:?}");
    assert!(second.as_secs() < 5, "second page took {second:?}");
}
