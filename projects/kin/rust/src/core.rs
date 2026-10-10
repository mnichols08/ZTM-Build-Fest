//! Portable application operations shared by the native library and manual ABI.
use crate::error::KinError;
use crate::protocol::{
    self, DecodedRequest, PROTOCOL_V10, PROTOCOL_V11, PROTOCOL_V12, PROTOCOL_V13, PROTOCOL_V14,
    PROTOCOL_V15, PROTOCOL_V16, PROTOCOL_V17, PROTOCOL_V18, PROTOCOL_V19, PROTOCOL_V20,
    PROTOCOL_V21, PROTOCOL_V6, PROTOCOL_V7, PROTOCOL_V8, PROTOCOL_V9,
};
use crate::state::{self, HouseholdState};

pub fn project(request: &DecodedRequest) -> Result<HouseholdState, KinError> {
    if request.protocol_version >= PROTOCOL_V8 {
        state::rebuild_distributed_on(
            &request.events,
            request.as_of.ok_or(KinError::MalformedProtocol)?,
            request.civil_date.ok_or(KinError::MalformedProtocol)?,
        )
    } else if let Some(date) = request.civil_date {
        state::rebuild_on(
            &request.events,
            request.as_of.ok_or(KinError::MalformedProtocol)?,
            date,
        )
    } else if let Some(time) = request.as_of {
        state::rebuild_at(&request.events, time)
    } else {
        state::rebuild(&request.events)
    }
}

pub fn encode_projection(
    request: &DecodedRequest,
    household: &HouseholdState,
) -> Result<Vec<u8>, KinError> {
    if request.protocol_version >= PROTOCOL_V6 {
        let summary =
            state::summarize_validated(&request.events, request.summary_cursor, household)?;
        match request.protocol_version {
            PROTOCOL_V8 => protocol::encode_state_v8(household, &summary),
            PROTOCOL_V9 => protocol::encode_state_v9(household, &summary),
            PROTOCOL_V10 => protocol::encode_state_v10(household, &summary),
            PROTOCOL_V11 => protocol::encode_state_v11(household, &summary),
            PROTOCOL_V12 => protocol::encode_state_v12(household, &summary),
            PROTOCOL_V13 => protocol::encode_state_v13(household, &summary),
            PROTOCOL_V14 => protocol::encode_state_v14(household, &summary),
            PROTOCOL_V15 => protocol::encode_state_v15(household, &summary),
            PROTOCOL_V16 => protocol::encode_state_v16(household, &summary),
            PROTOCOL_V17 => protocol::encode_state_v17(household, &summary),
            PROTOCOL_V18 => protocol::encode_state_v18(household, &summary),
            PROTOCOL_V19 => protocol::encode_state_v19(household, &summary),
            PROTOCOL_V20 => protocol::encode_state_v20(household, &summary),
            PROTOCOL_V21 => protocol::encode_state_v21(household, &summary),
            PROTOCOL_V7 => protocol::encode_state_v7(household, &summary),
            _ => protocol::encode_state_v6(household, &summary),
        }
    } else {
        protocol::encode_state(household, request.protocol_version)
    }
}

pub fn replay(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = protocol::decode_request_with_summary(bytes)?;
    encode_projection(&request, &project(&request)?)
}
