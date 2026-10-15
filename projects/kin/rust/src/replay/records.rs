//! Replay of areas, Notes, Reference Records, Maintenance events and attachment bindings.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::AreaCreated { area_id, name } => {
            let name = normalize_area_name(name)?;
            if !valid_timestamp(event.timestamp)
                || area_id.0 == [0; 16]
                || r.area_positions.contains_key(area_id)
                || r.areas.len() >= MAX_AREAS
            {
                return Err(KinError::InvalidEvent);
            }
            r.area_positions.insert(*area_id, r.areas.len());
            r.areas.push(AreaState {
                area_id: *area_id,
                name,
                archived: false,
            });
        }
        EventKind::AreaRenamed { area_id, name } => {
            let name = normalize_area_name(name)?;
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .area_positions
                .get(area_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            r.areas[position].name = name;
        }
        EventKind::AreaArchived { area_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .area_positions
                .get(area_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            r.areas[position].archived = true;
            r.pins.retain(|pin| {
                !(pin.target_kind == PinTargetKind::Area && pin.target_id == area_id.0)
            });
        }
        EventKind::NoteCreated {
            note_id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = normalize_note(title, body)?;
            if !valid_timestamp(event.timestamp)
                || note_id.0 == [0; 16]
                || r.note_positions.contains_key(note_id)
                || r.notes.len() >= MAX_NOTES
                || area_id.is_some_and(|id| {
                    r.area_positions
                        .get(&id)
                        .is_none_or(|position| r.areas[*position].archived)
                })
            {
                return Err(KinError::InvalidEvent);
            }
            r.note_positions.insert(*note_id, r.notes.len());
            r.notes.push(NoteState {
                note_id: *note_id,
                title,
                body,
                area_id: *area_id,
                created_by: event.actor_id,
                created_at: event.timestamp,
                updated_by: event.actor_id,
                updated_at: event.timestamp,
                status: NoteStatus::Active,
            });
        }
        EventKind::NoteUpdated {
            note_id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = normalize_note(title, body)?;
            let position = r
                .note_positions
                .get(note_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if !valid_timestamp(event.timestamp)
                || area_id.is_some_and(|id| {
                    r.area_positions.get(&id).is_none_or(|area_position| {
                        r.areas[*area_position].archived && r.notes[position].area_id != Some(id)
                    })
                })
            {
                return Err(KinError::InvalidEvent);
            }
            let concurrent_archive = r.note_archive_events.get(note_id).is_some_and(|archives| {
                archives.iter().any(|(logical_time, device_id)| {
                    *logical_time == event.logical_time && *device_id != event.device_id
                })
            });
            if r.notes[position].status == NoteStatus::Archived && !concurrent_archive {
                return Err(KinError::InvalidEvent);
            }
            if !concurrent_archive {
                r.notes[position].title = title;
                r.notes[position].body = body;
                r.notes[position].area_id = *area_id;
                r.notes[position].updated_by = event.actor_id;
                r.notes[position].updated_at = event.timestamp;
            }
        }
        EventKind::NoteArchived { note_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .note_positions
                .get(note_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let concurrent_archive = r.note_archive_events.get(note_id).is_some_and(|archives| {
                archives.iter().any(|(logical_time, device_id)| {
                    *logical_time == event.logical_time && *device_id != event.device_id
                })
            });
            if r.notes[position].status == NoteStatus::Archived && !concurrent_archive {
                return Err(KinError::InvalidEvent);
            }
            r.notes[position].status = NoteStatus::Archived;
            r.pins.retain(|pin| {
                !(pin.target_kind == PinTargetKind::Note && pin.target_id == note_id.0)
            });
        }
        EventKind::ReferenceRecordSaved {
            record_id,
            title,
            area_id,
            fields,
        } => {
            let (title, fields) = normalize_reference_text(title, fields)?;
            if !valid_timestamp(event.timestamp)
                || record_id.0 == [0; 16]
                || area_id.is_some_and(|id| !r.area_positions.contains_key(&id))
            {
                return Err(KinError::InvalidEvent);
            }
            let owner = *record_id;
            let concurrent_archive =
                r.reference_archive_events
                    .get(record_id)
                    .is_some_and(|archives| {
                        archives.iter().any(|(time, device)| {
                            *time == event.logical_time && *device != event.device_id
                        })
                    });
            if fields.iter().any(|field| {
                r.reference_field_owners
                    .get(&field.field_id)
                    .is_some_and(|existing| *existing != owner)
            }) {
                return Err(KinError::InvalidEvent);
            }
            for field in &fields {
                r.reference_field_owners.insert(field.field_id, owner);
            }
            if let Some(position) = r.reference_positions.get(record_id).copied() {
                let existing = &mut r.reference_records[position];
                if existing.archived && !concurrent_archive {
                    return Err(KinError::InvalidEvent);
                }
                if !concurrent_archive {
                    existing.title = title;
                    existing.area_id = *area_id;
                    existing.fields = fields;
                }
            } else {
                if r.reference_records.len() >= MAX_REFERENCE_RECORDS {
                    return Err(KinError::InvalidEvent);
                }
                r.reference_positions
                    .insert(*record_id, r.reference_records.len());
                r.reference_records.push(ReferenceRecordState {
                    record_id: *record_id,
                    title,
                    area_id: *area_id,
                    fields,
                    archived: false,
                });
            }
        }
        EventKind::ReferenceRecordArchived { record_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            r.reference_records
                .get_mut(
                    *r.reference_positions
                        .get(record_id)
                        .ok_or(KinError::InvalidEvent)?,
                )
                .ok_or(KinError::InvalidEvent)?
                .archived = true;
        }
        EventKind::MaintenanceEventSaved {
            maintenance_id,
            record_id,
            performed_on,
            summary,
            next_on,
            routine_id,
        } => {
            if !valid_timestamp(event.timestamp)
                || maintenance_id.0 == [0; 16]
                || record_id.0 == [0; 16]
            {
                return Err(KinError::InvalidEvent);
            }
            let summary = normalize_maintenance_summary(summary)?;
            let record_pos = *r
                .reference_positions
                .get(record_id)
                .ok_or(KinError::InvalidEvent)?;
            if (r.reference_records[record_pos].archived
                && !has_concurrent_archive(r.reference_archive_events.get(record_id), event))
                || performed_on.encoded() == 0
            {
                return Err(KinError::InvalidEvent);
            }
            if let Some(routine_id) = routine_id {
                let position = *r
                    .routine_positions
                    .get(routine_id)
                    .ok_or(KinError::InvalidEvent)?;
                if r.routines[position].archived {
                    return Err(KinError::InvalidEvent);
                }
            }
            if let Some(next_on) = next_on {
                if next_on < performed_on {
                    return Err(KinError::InvalidEvent);
                }
            }
            if let Some(existing) = r
                .maintenance_events
                .iter_mut()
                .find(|entry| entry.maintenance_id == *maintenance_id)
            {
                if existing.archived || existing.record_id != *record_id {
                    return Err(KinError::InvalidEvent);
                }
                *existing = MaintenanceEventState {
                    maintenance_id: *maintenance_id,
                    record_id: *record_id,
                    performed_on: *performed_on,
                    summary,
                    next_on: *next_on,
                    routine_id: *routine_id,
                    archived: false,
                };
            } else {
                if r.maintenance_events
                    .iter()
                    .filter(|entry| entry.record_id == *record_id)
                    .count()
                    >= MAX_MAINTENANCE_EVENTS_PER_RECORD
                {
                    return Err(KinError::InvalidEvent);
                }
                r.maintenance_events.push(MaintenanceEventState {
                    maintenance_id: *maintenance_id,
                    record_id: *record_id,
                    performed_on: *performed_on,
                    summary,
                    next_on: *next_on,
                    routine_id: *routine_id,
                    archived: false,
                });
            }
        }
        EventKind::MaintenanceEventArchived { maintenance_id } => {
            let entry = r
                .maintenance_events
                .iter_mut()
                .find(|entry| entry.maintenance_id == *maintenance_id)
                .ok_or(KinError::InvalidEvent)?;
            if entry.archived {
                return Err(KinError::InvalidEvent);
            }
            entry.archived = true;
        }
        EventKind::AttachmentBound {
            attachment_id,
            parent_kind,
            parent_id,
        } => {
            if attachment_id.0 == [0; 16]
                || *parent_id == [0; 16]
                || r.attachments
                    .iter()
                    .any(|entry| entry.attachment_id == *attachment_id)
                || r.attachments.len() >= MAX_ATTACHMENTS
            {
                return Err(KinError::InvalidEvent);
            }
            let parent_exists = match parent_kind {
                AttachmentParentKind::Note => {
                    r.notes.iter().any(|entry| entry.note_id.0 == *parent_id)
                }
                AttachmentParentKind::ReferenceRecord => r
                    .reference_records
                    .iter()
                    .any(|entry| entry.record_id.0 == *parent_id),
                AttachmentParentKind::Maintenance => r
                    .maintenance_events
                    .iter()
                    .any(|entry| entry.maintenance_id.0 == *parent_id),
                AttachmentParentKind::Item => {
                    r.items.iter().any(|entry| entry.item_id.0 == *parent_id)
                }
            };
            if !parent_exists {
                return Err(KinError::InvalidEvent);
            }
            r.attachments.push(AttachmentState {
                attachment_id: *attachment_id,
                parent_kind: *parent_kind,
                parent_id: *parent_id,
                removed: false,
            });
        }
        EventKind::AttachmentRemoved { attachment_id } => {
            let attachment = r
                .attachments
                .iter_mut()
                .find(|entry| entry.attachment_id == *attachment_id)
                .ok_or(KinError::InvalidEvent)?;
            if attachment.removed {
                return Err(KinError::InvalidEvent);
            }
            attachment.removed = true;
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
