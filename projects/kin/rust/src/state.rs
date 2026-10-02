use std::collections::BTreeMap;

use crate::error::KinError;
use crate::event::{ActorId, EventEnvelope, EventId, EventKind, HouseholdId, ItemId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemStatus {
    Active,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ItemState {
    pub item_id: ItemId,
    pub text: String,
    pub created_by: ActorId,
    pub created_at: i64,
    pub status: ItemStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HouseholdState {
    pub household_id: Option<HouseholdId>,
    pub items: Vec<ItemState>,
}

pub fn rebuild(events: &[EventEnvelope]) -> Result<HouseholdState, KinError> {
    let mut household_id = None;
    let mut items = Vec::new();
    let mut item_positions = BTreeMap::new();
    let mut event_bytes = BTreeMap::<EventId, Vec<u8>>::new();
    let mut last_logical_time = 0;

    for event in events {
        if let Some(previous_bytes) = event_bytes.get(&event.event_id) {
            if previous_bytes == &event.canonical_bytes {
                continue;
            }
            return Err(KinError::InvalidEvent);
        }

        if let Some(stream_household) = household_id {
            if stream_household != event.household_id {
                return Err(KinError::InvalidEvent);
            }
        } else {
            household_id = Some(event.household_id);
        }

        if event.logical_time <= last_logical_time {
            return Err(KinError::InvalidEvent);
        }

        match &event.kind {
            EventKind::ItemAdded { item_id, text } => {
                if text.trim().is_empty() || item_positions.contains_key(item_id) {
                    return Err(KinError::InvalidEvent);
                }
                item_positions.insert(*item_id, items.len());
                items.push(ItemState {
                    item_id: *item_id,
                    text: text.clone(),
                    created_by: event.actor_id,
                    created_at: event.timestamp,
                    status: ItemStatus::Active,
                });
            }
            EventKind::ItemCompleted { item_id } => {
                let position = item_positions
                    .get(item_id)
                    .copied()
                    .ok_or(KinError::InvalidEvent)?;
                items[position].status = ItemStatus::Completed;
            }
        }

        last_logical_time = event.logical_time;
        event_bytes.insert(event.event_id, event.canonical_bytes.clone());
    }

    Ok(HouseholdState {
        household_id,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{DeviceId, EventId};

    fn id(byte: u8) -> [u8; 16] {
        [byte; 16]
    }

    fn event(event_number: u8, logical_time: u64, kind: EventKind) -> EventEnvelope {
        let event_id = EventId(id(event_number));
        let mut canonical_bytes = vec![event_number, logical_time as u8];
        match &kind {
            EventKind::ItemAdded { item_id, text } => {
                canonical_bytes.extend_from_slice(&item_id.0);
                canonical_bytes.extend_from_slice(text.as_bytes());
            }
            EventKind::ItemCompleted { item_id } => canonical_bytes.extend_from_slice(&item_id.0),
        }
        EventEnvelope {
            event_id,
            household_id: HouseholdId(id(0xaa)),
            actor_id: ActorId(id(0xbb)),
            device_id: DeviceId(id(0xcc)),
            timestamp: 1_760_000_000_000 + i64::from(event_number),
            logical_time,
            kind,
            canonical_bytes,
        }
    }

    fn added(event_number: u8, logical_time: u64, item_number: u8, text: &str) -> EventEnvelope {
        event(
            event_number,
            logical_time,
            EventKind::ItemAdded {
                item_id: ItemId(id(item_number)),
                text: text.to_owned(),
            },
        )
    }

    #[test]
    fn add_item_creates_active_item() {
        let state = rebuild(&[added(1, 1, 0x11, "Buy milk")]).unwrap();
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[0].status, ItemStatus::Active);
    }

    #[test]
    fn multiple_items_keep_addition_order() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            added(2, 2, 0x22, "Restock wipes"),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items.len(), 2);
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[1].text, "Restock wipes");
    }

    #[test]
    fn completion_changes_only_derived_status() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items[0].text, "Buy milk");
        assert_eq!(state.items[0].status, ItemStatus::Completed);
    }

    #[test]
    fn unknown_completion_is_invalid() {
        let completion = event(
            1,
            1,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0xff)),
            },
        );
        assert_eq!(rebuild(&[completion]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn identical_event_delivery_is_idempotent() {
        let added = added(1, 1, 0x11, "Buy milk");
        let state = rebuild(&[added.clone(), added]).unwrap();
        assert_eq!(state.items.len(), 1);
    }

    #[test]
    fn event_id_reuse_with_different_bytes_fails() {
        let first = added(1, 1, 0x11, "Buy milk");
        let mut conflicting = added(2, 2, 0x22, "Restock wipes");
        conflicting.event_id = first.event_id;
        assert_eq!(rebuild(&[first, conflicting]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn duplicate_completion_is_a_valid_noop() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
            event(
                3,
                3,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items[0].status, ItemStatus::Completed);
    }

    #[test]
    fn rebuild_is_deterministic() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            event(
                2,
                2,
                EventKind::ItemCompleted {
                    item_id: ItemId(id(0x11)),
                },
            ),
        ];
        let state_a = rebuild(&events).unwrap();
        let state_b = rebuild(&events).unwrap();
        let state_c = rebuild(&events).unwrap();
        assert_eq!(state_a, state_b);
        assert_eq!(state_b, state_c);
        assert_eq!(state_a, state_c);
    }

    #[test]
    fn mixed_households_fail_as_a_whole() {
        let first = added(1, 1, 0x11, "Buy milk");
        let mut second = added(2, 2, 0x22, "Restock wipes");
        second.household_id = HouseholdId(id(0xdd));
        assert_eq!(rebuild(&[first, second]), Err(KinError::InvalidEvent));
    }

    #[test]
    fn whitespace_only_items_are_invalid() {
        assert_eq!(
            rebuild(&[added(1, 1, 0x11, " \t\n")]),
            Err(KinError::InvalidEvent)
        );
    }

    #[test]
    fn duplicate_item_identity_is_invalid() {
        let events = [
            added(1, 1, 0x11, "Buy milk"),
            added(2, 2, 0x11, "Restock wipes"),
        ];
        assert_eq!(rebuild(&events), Err(KinError::InvalidEvent));
    }

    #[test]
    fn non_increasing_logical_order_is_invalid() {
        let events = [
            added(1, 2, 0x11, "Buy milk"),
            added(2, 2, 0x22, "Restock wipes"),
        ];
        assert_eq!(rebuild(&events), Err(KinError::InvalidEvent));
    }
}
