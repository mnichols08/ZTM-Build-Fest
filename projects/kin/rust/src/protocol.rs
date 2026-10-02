use crate::error::KinError;
use crate::event::{ActorId, DeviceId, EventEnvelope, EventId, EventKind, HouseholdId, ItemId};
use crate::state::{HouseholdState, ItemStatus};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_EVENT_COUNT: usize = 10_000;
pub const MAX_PROTOCOL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ITEM_TEXT_BYTES: usize = 4096;
const REQUEST_HEADER_BYTES: usize = 12;
const EVENT_HEADER_BYTES: usize = 88;
const RESULT_HEADER_BYTES: usize = 12;
const ITEM_HEADER_BYTES: usize = 48;

pub fn decode_request(bytes: &[u8]) -> Result<Vec<EventEnvelope>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    if bytes.len() < REQUEST_HEADER_BYTES || &bytes[..4] != b"KINE" {
        return Err(KinError::MalformedProtocol);
    }

    let version = read_u16(bytes, 4)?;
    if version != PROTOCOL_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    if read_u16(bytes, 6)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let event_count = read_u32(bytes, 8)? as usize;
    if event_count > MAX_EVENT_COUNT {
        return Err(KinError::SizeLimit);
    }

    let mut events = Vec::new();
    events
        .try_reserve_exact(event_count)
        .map_err(|_| KinError::SizeLimit)?;
    let mut offset = REQUEST_HEADER_BYTES;
    for _ in 0..event_count {
        let header_end = offset
            .checked_add(EVENT_HEADER_BYTES)
            .ok_or(KinError::MalformedProtocol)?;
        let header = bytes
            .get(offset..header_end)
            .ok_or(KinError::MalformedProtocol)?;
        let payload_length = read_u32(header, 84)? as usize;
        let record_end = header_end
            .checked_add(payload_length)
            .ok_or(KinError::MalformedProtocol)?;
        let record = bytes
            .get(offset..record_end)
            .ok_or(KinError::MalformedProtocol)?;
        events.push(decode_event(record)?);
        offset = record_end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(events)
}

pub fn encode_state(state: &HouseholdState) -> Result<Vec<u8>, KinError> {
    let item_count = u32::try_from(state.items.len()).map_err(|_| KinError::SizeLimit)?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(RESULT_HEADER_BYTES)
        .map_err(|_| KinError::SizeLimit)?;
    result.extend_from_slice(b"KINS");
    push_u16(&mut result, PROTOCOL_VERSION);
    push_u16(&mut result, 0);
    push_u32(&mut result, item_count);

    for item in &state.items {
        let text_bytes = item.text.as_bytes();
        let text_length = u32::try_from(text_bytes.len()).map_err(|_| KinError::SizeLimit)?;
        let expected_length = result
            .len()
            .checked_add(ITEM_HEADER_BYTES)
            .and_then(|length| length.checked_add(text_bytes.len()))
            .ok_or(KinError::SizeLimit)?;
        if expected_length > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        result
            .try_reserve(expected_length - result.len())
            .map_err(|_| KinError::SizeLimit)?;
        result.extend_from_slice(&item.item_id.0);
        result.extend_from_slice(&item.created_by.0);
        result.extend_from_slice(&item.created_at.to_le_bytes());
        result.push(match item.status {
            ItemStatus::Active => 0,
            ItemStatus::Completed => 1,
        });
        result.extend_from_slice(&[0; 3]);
        push_u32(&mut result, text_length);
        result.extend_from_slice(text_bytes);
    }
    Ok(result)
}

fn decode_event(record: &[u8]) -> Result<EventEnvelope, KinError> {
    if record.len() < EVENT_HEADER_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    let event_version = read_u16(record, 0)?;
    if event_version != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let event_kind = read_u16(record, 2)?;
    let payload_length = read_u32(record, 84)? as usize;
    let expected_length = EVENT_HEADER_BYTES
        .checked_add(payload_length)
        .ok_or(KinError::MalformedProtocol)?;
    if record.len() != expected_length {
        return Err(KinError::MalformedProtocol);
    }

    let payload = &record[EVENT_HEADER_BYTES..];
    let kind = match event_kind {
        1 => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let text_length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&text_length)
                || payload.len()
                    != 20usize
                        .checked_add(text_length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let decoded_text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            let mut text = String::new();
            text.try_reserve_exact(text_length)
                .map_err(|_| KinError::SizeLimit)?;
            text.push_str(decoded_text);
            EventKind::ItemAdded {
                item_id: ItemId(read_id(payload, 0)?),
                text,
            }
        }
        2 => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemCompleted {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        _ => return Err(KinError::UnsupportedVersion),
    };

    let mut canonical_bytes = Vec::new();
    canonical_bytes
        .try_reserve_exact(record.len())
        .map_err(|_| KinError::SizeLimit)?;
    canonical_bytes.extend_from_slice(record);
    Ok(EventEnvelope {
        event_id: EventId(read_id(record, 4)?),
        household_id: HouseholdId(read_id(record, 20)?),
        actor_id: ActorId(read_id(record, 36)?),
        device_id: DeviceId(read_id(record, 52)?),
        timestamp: read_i64(record, 68)?,
        logical_time: read_u64(record, 76)?,
        kind,
        canonical_bytes,
    })
}

fn read_id(bytes: &[u8], offset: usize) -> Result<[u8; 16], KinError> {
    let id_bytes = bytes
        .get(offset..offset + 16)
        .ok_or(KinError::MalformedProtocol)?;
    let mut id = [0; 16];
    id.copy_from_slice(id_bytes);
    Ok(id)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, KinError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, KinError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(i64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::rebuild;

    fn request_with(record: &[u8], version: u16, count: u32) -> Vec<u8> {
        let mut bytes = b"KINE".to_vec();
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        bytes.extend_from_slice(record);
        bytes
    }

    fn added_record(text: &[u8]) -> Vec<u8> {
        let mut payload = vec![0x11; 16];
        payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
        payload.extend_from_slice(text);
        let mut record = Vec::new();
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&[1; 16]);
        record.extend_from_slice(&[0xaa; 16]);
        record.extend_from_slice(&[0xbb; 16]);
        record.extend_from_slice(&[0xcc; 16]);
        record.extend_from_slice(&1i64.to_le_bytes());
        record.extend_from_slice(&1u64.to_le_bytes());
        record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        record.extend_from_slice(&payload);
        record
    }

    #[test]
    fn empty_request_rebuilds_empty_state() {
        let request = request_with(&[], PROTOCOL_VERSION, 0);
        let events = decode_request(&request).unwrap();
        let result = encode_state(&rebuild(&events).unwrap()).unwrap();
        assert_eq!(&result[..4], b"KINS");
        assert_eq!(result.len(), RESULT_HEADER_BYTES);
    }

    #[test]
    fn unsupported_protocol_is_rejected() {
        let request = request_with(&[], 2, 0);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn truncated_request_header_is_rejected_at_every_short_length() {
        let header = request_with(&[], PROTOCOL_VERSION, 0);
        for length in 0..REQUEST_HEADER_BYTES {
            assert_eq!(
                decode_request(&header[..length]),
                Err(KinError::MalformedProtocol),
                "length {length}"
            );
        }
    }

    #[test]
    fn nonzero_request_reserved_field_is_rejected() {
        let mut request = request_with(&[], PROTOCOL_VERSION, 0);
        request[6] = 1;
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn truncated_event_header_is_rejected_at_every_short_length() {
        let record = added_record(b"Milk");
        for record_length in 0..EVENT_HEADER_BYTES {
            let request = request_with(&record[..record_length], PROTOCOL_VERSION, 1);
            assert_eq!(
                decode_request(&request),
                Err(KinError::MalformedProtocol),
                "record length {record_length}"
            );
        }
    }

    #[test]
    fn truncated_event_payload_is_rejected_at_every_short_length() {
        let record = added_record(b"Milk");
        for record_length in EVENT_HEADER_BYTES..record.len() {
            let request = request_with(&record[..record_length], PROTOCOL_VERSION, 1);
            assert_eq!(
                decode_request(&request),
                Err(KinError::MalformedProtocol),
                "record length {record_length}"
            );
        }
    }

    #[test]
    fn declared_payload_larger_than_available_bytes_is_rejected() {
        let mut record = added_record(b"Milk");
        record[84..88].copy_from_slice(&u32::MAX.to_le_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn unsupported_event_schema_is_rejected() {
        let mut record = added_record(b"Buy milk");
        record[..2].copy_from_slice(&2u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn unsupported_event_kind_is_rejected() {
        let mut record = added_record(b"Buy milk");
        record[2..4].copy_from_slice(&3u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn completion_payload_with_wrong_length_is_rejected() {
        let mut record = added_record(b"Milk");
        record[2..4].copy_from_slice(&2u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn malformed_text_length_is_rejected() {
        let mut record = added_record(b"hi");
        record[EVENT_HEADER_BYTES + 16..EVENT_HEADER_BYTES + 20]
            .copy_from_slice(&5u32.to_le_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn empty_or_oversized_text_payloads_are_rejected() {
        for (declared_length, text) in [(0u32, b"".as_slice()), (4097, b"x".as_slice())] {
            let mut record = added_record(text);
            record[EVENT_HEADER_BYTES + 16..EVENT_HEADER_BYTES + 20]
                .copy_from_slice(&declared_length.to_le_bytes());
            let request = request_with(&record, PROTOCOL_VERSION, 1);
            assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
        }
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        let record = added_record(&[0xff]);
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn trailing_request_bytes_are_rejected() {
        let mut request = request_with(&[], PROTOCOL_VERSION, 0);
        request.push(0);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn event_count_limit_is_enforced_before_record_parsing() {
        let request = request_with(&[], PROTOCOL_VERSION, (MAX_EVENT_COUNT + 1) as u32);
        assert_eq!(decode_request(&request), Err(KinError::SizeLimit));
    }

    #[test]
    fn maximum_utf8_item_text_is_accepted() {
        let record = added_record(&vec![b'x'; MAX_ITEM_TEXT_BYTES]);
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        let events = decode_request(&request).unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ItemAdded { text, .. } if text.len() == MAX_ITEM_TEXT_BYTES)
        );
    }

    #[test]
    fn bom_and_emoji_text_are_preserved() {
        let text = "\u{feff}milk 🥛";
        let record = added_record(text.as_bytes());
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        let events = decode_request(&request).unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ItemAdded { text: decoded, .. } if decoded == text)
        );
    }

    #[test]
    fn item_text_above_byte_limit_is_rejected() {
        let record = added_record(&vec![b'x'; MAX_ITEM_TEXT_BYTES + 1]);
        let request = request_with(&record, PROTOCOL_VERSION, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }
}
