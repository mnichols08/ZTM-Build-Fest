//! Replay of routines (creation, occurrence completion, archive) and Playbooks.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::RoutineCreated {
            routine_id,
            text,
            cadence,
            created_on,
        } => {
            if !valid_timestamp(event.timestamp) || text.len() > 4096 || text.is_empty() {
                return Err(KinError::MalformedProtocol);
            }
            if text.trim().is_empty() || r.routine_positions.contains_key(routine_id) {
                return Err(KinError::InvalidEvent);
            }
            r.routine_positions.insert(*routine_id, r.routines.len());
            r.routines.push(RoutineState {
                routine_id: *routine_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                created_on: *created_on,
                cadence: *cadence,
                archived: false,
                // Occurrence fields depend on the civil date: set in finalize.
                occurrence_key: None,
                completed: false,
                next_start: None,
            });
        }
        EventKind::RoutineOccurrenceCompleted { routine_id, key }
        | EventKind::RoutineOccurrenceReopened { routine_id, key } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .routine_positions
                .get(routine_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let routine = &r.routines[position];
            routine.cadence.validate_key(routine.created_on, *key)?;
            if routine.archived {
                if !is_concurrent_terminal_conflict(
                    r.routine_archives.get(routine_id).copied(),
                    event,
                ) {
                    return Err(KinError::InvalidEvent);
                }
            } else if matches!(event.kind, EventKind::RoutineOccurrenceCompleted { .. }) {
                r.completed_periods.insert((*routine_id, *key));
            } else {
                r.completed_periods.remove(&(*routine_id, *key));
            }
        }
        EventKind::RoutineArchived { routine_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .routine_positions
                .get(routine_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let routine = &mut r.routines[position];
            if routine.archived {
                if !is_concurrent_terminal_conflict(
                    r.routine_archives.get(routine_id).copied(),
                    event,
                ) {
                    return Err(KinError::InvalidEvent);
                }
            } else {
                routine.archived = true;
                routine.occurrence_key = None;
                routine.next_start = None;
                r.routine_archives
                    .insert(*routine_id, (event.logical_time, event.device_id));
            }
            r.pins.retain(|pin| {
                !(pin.target_kind == PinTargetKind::Routine && pin.target_id == routine_id.0)
            });
        }
        EventKind::PlaybookSaved {
            playbook_id,
            title,
            entries,
        } => {
            let (title, entries) = normalize_playbook(title, entries)?;
            if !valid_timestamp(event.timestamp) || playbook_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            if let Some(existing) = r
                .playbooks
                .iter_mut()
                .find(|record| record.playbook_id == *playbook_id)
            {
                if existing.archived {
                    return Err(KinError::InvalidEvent);
                }
                existing.title = title;
                existing.entries = entries;
            } else {
                if r.playbooks.len() >= MAX_PLAYBOOKS {
                    return Err(KinError::InvalidEvent);
                }
                r.playbooks.push(PlaybookState {
                    playbook_id: *playbook_id,
                    title,
                    entries,
                    archived: false,
                });
            }
        }
        EventKind::PlaybookArchived { playbook_id } => {
            let record = r
                .playbooks
                .iter_mut()
                .find(|record| record.playbook_id == *playbook_id)
                .ok_or(KinError::InvalidEvent)?;
            record.archived = true;
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
