//! Portable application operations shared by the native library and manual ABI.
use crate::error::KinError;
use crate::request::{decode_request, DecodedRequest};
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

pub fn replay(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = decode_request(bytes)?;
    encode_projection(&request, &project(&request)?)
}
