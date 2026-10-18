//! Replay of household chat (#109).
//!
//! Chat events never fail replay once they have decoded: an event that
//! conflicts with what this history knows is kept and changes nothing, as
//! with device names. Commands enforce the rules when an event is created
//! (command.rs), so a well-behaved device never writes one of these; a
//! history may still hold them (another device's bug, or a member who joined
//! later and never received the message an edit refers to).
//!
//! - Every blob reference is used once: an event whose blob this log has
//!   already seen is a conflict and changes nothing (it could otherwise
//!   make a live blob a retired one).
//! - A post adds a message, unless a message with that ID exists (the first
//!   post wins; the second post's blob is retired, since nothing shows it).
//! - Only the author edits, only a text message, and never a deleted one. An
//!   edit replaces the content blob; the old one is retired. An edit that
//!   can't apply to a message this log holds (another member's, an
//!   attachment's, or the author's after or concurrent with their own
//!   deletion) retires its new blob, so a deleted message's edited text
//!   doesn't survive.
//! - The author deletes for everyone: terminal, and it retires the current
//!   blob. Deletion wins over an edit at the same logical time in either
//!   replay order, because replay order is total and a delete is terminal:
//!   whichever sorts first, the message ends deleted.
//! - An admin deleting someone else's message records a claim. Whether the
//!   claimant is an admin is the service's to say, so the claim takes effect
//!   when the host reads a page and names the admins (chat.rs).
//!
//! Actors and devices are the event header's, after identity bindings.
use std::sync::Arc;

use super::*;
use crate::chat::{ChatMessage, ChatMessageStatus};
use crate::event::ChatContentKind;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    // Copy-on-write: a finalized state shares the chat until it changes.
    let chat = Arc::make_mut(&mut r.chat);
    match &event.kind {
        EventKind::ChatMessagePosted {
            message_id,
            content_kind,
            blob_ref,
            blob_key,
        } => {
            if !chat.seen.insert(*blob_ref) {
                return Ok(());
            }
            if chat.positions.contains_key(message_id) {
                chat.retired.push(*blob_ref);
                return Ok(());
            }
            chat.positions.insert(*message_id, chat.messages.len());
            chat.messages.push(ChatMessage {
                message_id: *message_id,
                author: event.actor_id,
                device: event.device_id,
                posted_at: event.timestamp,
                edited_at: 0,
                status: ChatMessageStatus::Live,
                content_kind: *content_kind,
                blob_ref: *blob_ref,
                blob_key: *blob_key,
            });
        }
        EventKind::ChatMessageEdited {
            message_id,
            blob_ref,
            blob_key,
        } => {
            if !chat.seen.insert(*blob_ref) {
                return Ok(());
            }
            let Some(&at) = chat.positions.get(message_id) else {
                return Ok(());
            };
            let message = &mut chat.messages[at];
            // An edit every history that holds the message ignores (another
            // member's, an attachment's, or one that lost to the author's own
            // deletion) leaves its blob shown nowhere: retire it. An edit of
            // a message this history lacks is kept as is; where the message
            // is known, the edit may apply.
            if message.author != event.actor_id
                || message.content_kind != ChatContentKind::Text
                || message.status == ChatMessageStatus::Deleted
            {
                chat.retired.push(*blob_ref);
                return Ok(());
            }
            let old = std::mem::replace(&mut message.blob_ref, *blob_ref);
            message.blob_key = *blob_key;
            message.status = ChatMessageStatus::Edited;
            message.edited_at = event.timestamp;
            chat.retired.push(old);
        }
        EventKind::ChatMessageDeleted {
            message_id,
            by_admin,
        } => {
            let Some(&at) = chat.positions.get(message_id) else {
                return Ok(());
            };
            let message = &mut chat.messages[at];
            if message.status == ChatMessageStatus::Deleted {
                return Ok(());
            }
            if message.author == event.actor_id {
                let old = std::mem::take(&mut message.blob_ref);
                message.blob_key = [0; 32];
                message.status = ChatMessageStatus::Deleted;
                chat.retired.push(old);
            } else if *by_admin {
                let claims = chat.admin_claims.entry(*message_id).or_default();
                if !claims.contains(&event.actor_id) {
                    claims.push(event.actor_id);
                }
            }
        }
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
