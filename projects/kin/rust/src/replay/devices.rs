//! Replay of device names (#71).
//!
//! `DeviceDescribed` records the automatic name a device announces for
//! itself: the device is the event's header device, and its member is the
//! header actor, both after identity bindings. A device keeps the member it
//! was first described by; a description from another member is invalid.
//! A device may describe itself again (a browser update changes its name),
//! and the latest description in replay order wins.
//!
//! `DeviceNicknamed` sets or clears a nickname. The target must already be
//! described, and only its member may name it, from any of their devices.
//! The member's device saw the description before naming it, so the
//! nickname always has a greater logical time and replays after it. The
//! latest nickname in replay order wins.
//!
//! Names are canonical by the time they get here: the decoder rejects
//! anything `normalize_device_name` or `normalize_device_nickname` would
//! change.
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::DeviceDescribed { auto_name } => {
            if event.device_id.0 == [0; 16] || event.actor_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            match r.devices.get_mut(&event.device_id) {
                Some(device) if device.member_id != event.actor_id => {
                    return Err(KinError::InvalidEvent)
                }
                Some(device) => device.auto_name.clone_from(auto_name),
                None => {
                    r.devices.insert(
                        event.device_id,
                        DeviceNameState {
                            device_id: event.device_id,
                            member_id: event.actor_id,
                            auto_name: auto_name.clone(),
                            nickname: None,
                        },
                    );
                }
            }
        }
        EventKind::DeviceNicknamed {
            device_id,
            nickname,
        } => match r.devices.get_mut(device_id) {
            Some(device) if device.member_id == event.actor_id => {
                device.nickname.clone_from(nickname)
            }
            _ => return Err(KinError::InvalidEvent),
        },
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
