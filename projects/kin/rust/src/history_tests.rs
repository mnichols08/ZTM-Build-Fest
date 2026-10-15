// The instance-held history: append batches, truncate, clear, and replay
// that matches a whole KINE request byte for byte.
use std::path::PathBuf;

use crate::core::{replay, replay_history};
use crate::error::KinError;
use crate::history::History;
use crate::test_support::*;
use crate::wire::{BINDING_BYTES, EVENT_HEADER_BYTES, MAX_EVENT_COUNT, REQUEST_HEADER_BYTES};

/// An append batch: count, one length per record, then the records.
fn batch(records: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = (records.len() as u32).to_le_bytes().to_vec();
    for record in records {
        bytes.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A KINE request split into its record-less context and its records.
fn split(request: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
    let count = header_u32(request, 8) as usize;
    let bindings = u16::from_le_bytes([request[60], request[61]]) as usize;
    let mut offset = REQUEST_HEADER_BYTES + bindings * BINDING_BYTES;
    let mut context = request[..offset].to_vec();
    context[8..12].fill(0);
    let mut records = Vec::new();
    for _ in 0..count {
        let payload = header_u32(request, offset + 84) as usize;
        let end = offset + EVENT_HEADER_BYTES + payload;
        records.push(request[offset..end].to_vec());
        offset = end;
    }
    assert_eq!(offset, request.len());
    (context, records)
}

#[test]
fn replaying_held_history_matches_the_whole_request_for_every_golden_fixture() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rust/fixtures/golden");
    for name in ["empty", "full", "distributed", "pulse-expiry", "bulk"] {
        let request = std::fs::read(fixtures.join(format!("{name}.kine"))).unwrap();
        let (context, records) = split(&request);
        let mut history = History::new();
        // Appended in two batches, as a host appends what changed.
        let half = records.len() / 2;
        history.append(&batch(&records[..half])).unwrap();
        history.append(&batch(&records[half..])).unwrap();
        assert_eq!(history.len(), records.len(), "{name}");
        assert_eq!(
            replay_history(&context, &history).unwrap(),
            replay(&request).unwrap(),
            "{name}"
        );
    }
}

#[test]
fn records_round_trip_and_truncate_drops_from_the_end() {
    let records = vec![
        item_record(1, 0x11, b"Milk", 1),
        text_record(5, 2, 0x12, b"Bins"),
        item_record(3, 0x13, b"Eggs", 2),
    ];
    let mut history = History::new();
    history.append(&batch(&records)).unwrap();
    assert_eq!(
        history.records().map(<[u8]>::to_vec).collect::<Vec<_>>(),
        records
    );
    history.truncate(1).unwrap();
    assert_eq!(
        history.records().map(<[u8]>::to_vec).collect::<Vec<_>>(),
        records[..1]
    );
    assert_eq!(history.truncate(2).unwrap_err(), KinError::InvalidAbi);
    history.append(&batch(&records[2..])).unwrap();
    assert_eq!(history.len(), 2);
    history.clear();
    assert!(history.is_empty());
    history.append(&batch(&[])).unwrap();
    assert!(history.is_empty());
}

#[test]
fn a_bad_record_or_layout_leaves_the_history_unchanged() {
    let good = item_record(1, 0x11, b"Milk", 1);
    let mut bad = item_record(2, 0x12, b"Eggs", 1);
    bad[2] = 99; // unknown event kind (u16 at byte 2)
    let mut history = History::new();
    history.append(&batch(std::slice::from_ref(&good))).unwrap();
    assert!(history.append(&batch(&[good.clone(), bad])).is_err());
    assert_eq!(history.len(), 1);
    let mut short = batch(std::slice::from_ref(&good));
    short.pop();
    assert_eq!(
        history.append(&short).unwrap_err(),
        KinError::MalformedProtocol
    );
    let mut long = batch(std::slice::from_ref(&good));
    long.push(0);
    assert_eq!(
        history.append(&long).unwrap_err(),
        KinError::MalformedProtocol
    );
    assert_eq!(
        history.append(&[1, 0]).unwrap_err(),
        KinError::MalformedProtocol
    );
    let mut huge = (MAX_EVENT_COUNT as u32).to_le_bytes().to_vec();
    huge.extend_from_slice(&[0; 8]);
    assert_eq!(history.append(&huge).unwrap_err(), KinError::SizeLimit);
    assert_eq!(history.len(), 1);
}

#[test]
fn a_projection_context_must_carry_no_records() {
    let records = [item_record(1, 0x11, b"Milk", 1)];
    let request = kine(&records, 0, TEST_DATE, None);
    let history = History::new();
    assert_eq!(
        replay_history(&request, &history).unwrap_err(),
        KinError::MalformedProtocol
    );
}
