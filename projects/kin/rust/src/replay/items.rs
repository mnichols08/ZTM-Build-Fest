//! Replay of items and their Steps: adding, completing, reopening, archiving, Area and planning date.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::ItemAdded {
            item_id,
            text,
            classification,
        } => {
            if text.trim().is_empty() || r.item_positions.contains_key(item_id) {
                return Err(KinError::InvalidEvent);
            }
            r.item_positions.insert(*item_id, r.items.len());
            r.items.push(ItemState {
                item_id: *item_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                last_changed_at: event.timestamp,
                classification: *classification,
                planning_date: None,
                status: ItemStatus::Active,
                area_id: None,
                steps: Vec::new(),
            });
        }
        EventKind::ItemAreaChanged { item_id, area_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if area_id.is_some_and(|id| !r.area_positions.contains_key(&id)) {
                return Err(KinError::InvalidEvent);
            }
            if r.items[position].area_id != *area_id {
                r.items[position].area_id = *area_id;
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemPlanningDateChanged {
            item_id,
            planning_date,
        } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if r.items[position].planning_date != *planning_date {
                r.items[position].planning_date = *planning_date;
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemStepAdded {
            item_id,
            step_id,
            text,
        } => {
            let text = normalize_step_text(text)?;
            if !valid_timestamp(event.timestamp)
                || step_id.0 == [0; 16]
                || !r.seen_step_ids.insert(*step_id)
            {
                return Err(KinError::InvalidEvent);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if has_concurrent_archive(r.item_archive_events.get(item_id), event) {
                // A same-time parent archive is terminal regardless of replay order.
            } else if r.items[position].status != ItemStatus::Active
                || r.items[position].steps.len() >= MAX_STEPS_PER_ITEM
            {
                return Err(KinError::InvalidEvent);
            } else {
                r.items[position].steps.push(ItemStepState {
                    step_id: *step_id,
                    text,
                    completed: false,
                    archived: false,
                });
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemStepCompleted { item_id, step_id }
        | EventKind::ItemStepReopened { item_id, step_id }
        | EventKind::ItemStepArchived { item_id, step_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if has_concurrent_archive(r.item_archive_events.get(item_id), event) {
                // A same-time parent archive is terminal regardless of replay order.
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            let concurrent_step_archive =
                has_concurrent_archive(r.step_archive_events.get(step_id), event);
            if concurrent_step_archive && !matches!(event.kind, EventKind::ItemStepArchived { .. })
            {
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            if r.items[position].status != ItemStatus::Active {
                return Err(KinError::InvalidEvent);
            }
            let step = r.items[position]
                .steps
                .iter_mut()
                .find(|step| step.step_id == *step_id)
                .ok_or(KinError::InvalidEvent)?;
            if step.archived {
                if concurrent_step_archive {
                    // Recorded as applied with no other effect (Replay::apply records it).
                    return Ok(());
                }
                return Err(KinError::InvalidEvent);
            }
            let changed = match event.kind {
                EventKind::ItemStepCompleted { .. } => {
                    let changed = !step.completed;
                    step.completed = true;
                    changed
                }
                EventKind::ItemStepReopened { .. } => {
                    let changed = step.completed;
                    step.completed = false;
                    changed
                }
                EventKind::ItemStepArchived { .. } => {
                    step.archived = true;
                    true
                }
                _ => unreachable!(),
            };
            if changed {
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemCompleted { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active => {
                    r.items[position].status = ItemStatus::Completed;
                    r.items[position].last_changed_at = event.timestamp;
                }
                ItemStatus::Completed => {}
                ItemStatus::Archived => {
                    if r.item_archives
                        .get(item_id)
                        .is_some_and(|(_, device)| *device != event.device_id)
                    {
                        // A different device may have authored this while
                        // offline; archive wins without poisoning replay.
                    } else {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        EventKind::ItemReopened { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active => {}
                ItemStatus::Completed => {
                    r.items[position].status = ItemStatus::Active;
                    r.items[position].last_changed_at = event.timestamp;
                }
                ItemStatus::Archived => {
                    if r.item_archives
                        .get(item_id)
                        .is_some_and(|(_, device)| *device != event.device_id)
                    {
                        // A different device may have authored this while
                        // offline; archive wins without poisoning replay.
                    } else {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        EventKind::ItemArchived { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active | ItemStatus::Completed => {
                    r.items[position].status = ItemStatus::Archived;
                    r.items[position].last_changed_at = event.timestamp;
                    r.item_archives
                        .insert(*item_id, (event.logical_time, event.device_id));
                }
                ItemStatus::Archived => {
                    if !is_concurrent_terminal_conflict(
                        r.item_archives.get(item_id).copied(),
                        event,
                    ) {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
