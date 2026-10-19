//! Portable application operations shared by the native library and manual ABI.
use crate::error::KinError;
use crate::history::History;
use crate::request::{decode_context, decode_request, DecodedRequest};
use crate::state::{self, HouseholdState};
use crate::state_encode::encode_state;

/// Deterministic replay of a decoded request at its explicit `as_of` and civil date.
pub fn project(request: &DecodedRequest) -> Result<HouseholdState, KinError> {
    state::rebuild(&request.events, request.as_of, request.civil_date)
}

/// The protocol-24 projection, including the catch-up summary after the cursor.
pub fn encode_projection(
    request: &DecodedRequest,
    household: &HouseholdState,
) -> Result<Vec<u8>, KinError> {
    let summary = state::summarize_validated(&request.events, request.summary_cursor, household)?;
    encode_state(household, &summary)
}

/// Replay of a whole KINE request (tests, golden fixtures, import plans).
pub fn replay(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = decode_request(bytes)?;
    encode_projection(&request, &project(&request)?)
}

/// Replay of the history an engine instance holds, in the context a
/// record-less KINE request gives (`kin_project`).
pub fn replay_history(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    let summary = history.summary(&context, &state, None)?;
    crate::state_encode::encode_state(&state, &summary)
}

/// KDEV v1, the device-name table (`kin_device_names`): "KDEV", version u16,
/// reserved u16 (0), record count u32, then per device in device-ID order:
/// device ID (16 bytes), member ID (16), automatic-name length u16 (0 when
/// this history holds only a nickname for the device), nickname length u16
/// (0 when there is none), the automatic name, then the nickname, both UTF-8.
pub const DEVICE_NAMES_VERSION: u16 = 1;

/// The device names in the history an engine instance holds, in the
/// context of a record-less KINE request (as `replay_history`).
pub fn device_names(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    encode_device_names(&state.devices)
}

/// A chat page (`kin_chat_page`): a KCHQ request (chat.rs) carrying the
/// record-less KINE context, against the instance's history. Texts of
/// retired blobs, and of messages the page shows as deleted or removed, are
/// forgotten from the arena first, so a deleted message's text never comes
/// back out.
pub fn chat_page(
    input: &[u8],
    history: &mut History,
    texts: &mut crate::chat::ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let request = crate::chat::decode_page_request(input)?;
    let context = decode_context(request.context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    let chat = &state.chat;
    let retired = chat.retired_blobs(&request.admins);
    for blob in &retired {
        texts.forget(blob);
    }
    crate::chat::encode_page(chat, &request, texts, &retired)
}

/// A chat search (`kin_chat_search`): a KCHF request (chat_search.rs)
/// against the instance's chat log and text arena. Texts of retired blobs
/// are forgotten first, as a page does, so a deleted message never matches.
pub fn chat_search(
    input: &[u8],
    history: &mut History,
    texts: &mut crate::chat::ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let request = crate::chat_search::decode_search_request(input)?;
    let context = decode_context(request.context)?;
    let chat = history.replay(&context)?.chat();
    for blob in &chat.retired_blobs(&request.admins) {
        texts.forget(blob);
    }
    crate::chat_search::encode_search(chat, &request, texts)
}

pub fn encode_device_names(devices: &[state::DeviceNameState]) -> Result<Vec<u8>, KinError> {
    let size = devices.iter().try_fold(12usize, |size, device| {
        size.checked_add(
            36 + device.auto_name.as_ref().map_or(0, String::len)
                + device.nickname.as_ref().map_or(0, String::len),
        )
    });
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size.ok_or(KinError::SizeLimit)?)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KDEV");
    bytes.extend_from_slice(&DEVICE_NAMES_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let count = u32::try_from(devices.len()).map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(&count.to_le_bytes());
    for device in devices {
        let auto_name = device.auto_name.as_deref().unwrap_or("");
        let nickname = device.nickname.as_deref().unwrap_or("");
        // Canonical names are at most MAX_DEVICE_NAME_BYTES, well inside u16.
        let auto_length = u16::try_from(auto_name.len()).map_err(|_| KinError::Internal)?;
        let nickname_length = u16::try_from(nickname.len()).map_err(|_| KinError::Internal)?;
        bytes.extend_from_slice(&device.device_id.0);
        bytes.extend_from_slice(&device.member_id.0);
        bytes.extend_from_slice(&auto_length.to_le_bytes());
        bytes.extend_from_slice(&nickname_length.to_le_bytes());
        bytes.extend_from_slice(auto_name.as_bytes());
        bytes.extend_from_slice(nickname.as_bytes());
    }
    Ok(bytes)
}
