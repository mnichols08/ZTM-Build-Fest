//! The catch-up summary: what changed after the cursor, in arrival order.
use super::*;

pub fn summarize_validated(
    events: &[EventEnvelope],
    cursor: Option<EventId>,
    state: &HouseholdState,
) -> Result<CatchUpSummary, KinError> {
    let start = match cursor {
        Some(cursor_id) => events
            .iter()
            .position(|event| event.event_id == cursor_id)
            .map(|index| index + 1)
            .ok_or(KinError::InvalidEvent)?,
        None => 0,
    };
    let mut seen: BTreeSet<EventId> = events[..start].iter().map(|event| event.event_id).collect();
    let items: BTreeMap<ItemId, (&str, ItemClassification)> = state
        .items
        .iter()
        .map(|item| (item.item_id, (item.text.as_str(), item.classification)))
        .collect();
    let handoffs: BTreeMap<HandoffId, &str> = state
        .handoffs
        .iter()
        .map(|handoff| (handoff.handoff_id, handoff.text.as_str()))
        .collect();
    let talks: BTreeMap<TalkId, &str> = state
        .talks
        .iter()
        .map(|talk| (talk.talk_id, talk.text.as_str()))
        .collect();
    let mut entries = Vec::new();
    let routines: BTreeMap<RoutineId, &str> = state
        .routines
        .iter()
        .map(|routine| (routine.routine_id, routine.text.as_str()))
        .collect();
    let mut total_count = 0u32;

    for event in &events[start..] {
        if !seen.insert(event.event_id) {
            continue;
        }
        let summary = match &event.kind {
            EventKind::RoutineCreated { text, .. } => Some((
                SummaryKind::RoutineCreated,
                SummaryEntityKind::Routine,
                text.as_str(),
                None,
            )),
            EventKind::RoutineOccurrenceCompleted { routine_id, .. } => {
                routines.get(routine_id).map(|text| {
                    (
                        SummaryKind::RoutineOccurrenceCompleted,
                        SummaryEntityKind::Routine,
                        *text,
                        None,
                    )
                })
            }
            EventKind::RoutineOccurrenceReopened { routine_id, .. } => {
                routines.get(routine_id).map(|text| {
                    (
                        SummaryKind::RoutineOccurrenceReopened,
                        SummaryEntityKind::Routine,
                        *text,
                        None,
                    )
                })
            }
            EventKind::RoutineArchived { routine_id } => routines.get(routine_id).map(|text| {
                (
                    SummaryKind::RoutineArchived,
                    SummaryEntityKind::Routine,
                    *text,
                    None,
                )
            }),
            EventKind::ItemAdded {
                item_id: _,
                text,
                classification,
            } => Some((
                SummaryKind::ItemAdded,
                SummaryEntityKind::Item,
                text.as_str(),
                Some(*classification),
            )),
            EventKind::ItemCompleted { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemCompleted,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::ItemReopened { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemReopened,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::ItemArchived { item_id } => items.get(item_id).map(|(text, _)| {
                (
                    SummaryKind::ItemArchived,
                    SummaryEntityKind::Item,
                    *text,
                    None,
                )
            }),
            EventKind::HandoffAdded { text, .. } => Some((
                SummaryKind::HandoffAdded,
                SummaryEntityKind::Handoff,
                text.as_str(),
                None,
            )),
            EventKind::HandoffAcknowledged { handoff_id } => handoffs.get(handoff_id).map(|text| {
                (
                    SummaryKind::HandoffAcknowledged,
                    SummaryEntityKind::Handoff,
                    *text,
                    None,
                )
            }),
            EventKind::HandoffArchived { handoff_id } => handoffs.get(handoff_id).map(|text| {
                (
                    SummaryKind::HandoffArchived,
                    SummaryEntityKind::Handoff,
                    *text,
                    None,
                )
            }),
            EventKind::TalkAdded { text, .. } => Some((
                SummaryKind::TalkAdded,
                SummaryEntityKind::Talk,
                text.as_str(),
                None,
            )),
            EventKind::TalkResolved { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkResolved,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::TalkReopened { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkReopened,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::TalkArchived { talk_id } => talks.get(talk_id).map(|text| {
                (
                    SummaryKind::TalkArchived,
                    SummaryEntityKind::Talk,
                    *text,
                    None,
                )
            }),
            EventKind::PulseSet { .. }
            | EventKind::PulseCleared
            | EventKind::AreaCreated { .. }
            | EventKind::AreaRenamed { .. }
            | EventKind::AreaArchived { .. }
            | EventKind::ItemAreaChanged { .. }
            | EventKind::NoteCreated { .. }
            | EventKind::NoteUpdated { .. }
            | EventKind::NoteArchived { .. }
            | EventKind::ItemStepAdded { .. }
            | EventKind::ItemStepCompleted { .. }
            | EventKind::ItemStepReopened { .. }
            | EventKind::ItemStepArchived { .. }
            | EventKind::HouseholdModeChanged { .. }
            | EventKind::ItemPlanningDateChanged { .. }
            | EventKind::PinAdded { .. }
            | EventKind::PinRemoved { .. }
            | EventKind::PlaybookSaved { .. }
            | EventKind::PlaybookArchived { .. }
            | EventKind::ReferenceRecordSaved { .. }
            | EventKind::ReferenceRecordArchived { .. }
            | EventKind::MaintenanceEventSaved { .. }
            | EventKind::MaintenanceEventArchived { .. }
            | EventKind::AttachmentBound { .. }
            | EventKind::AttachmentRemoved { .. }
            | EventKind::ResponsibilityChanged { .. } => None,
        };

        if let Some((kind, entity_kind, text, classification)) = summary {
            total_count = total_count.checked_add(1).ok_or(KinError::SizeLimit)?;
            if entries.len() == MAX_SUMMARY_ENTRIES {
                entries.remove(0);
            }
            entries.push(SummaryEntry {
                event_id: event.event_id,
                kind,
                entity_kind,
                text: text.to_owned(),
                classification,
            });
        }
    }

    Ok(CatchUpSummary {
        entries,
        total_count,
        through_event_id: events.last().map(|event| event.event_id),
    })
}
