//! Household chat (#109): the chat domain's state, its text rules, the text
//! arena, and the page the host reads.
//!
//! Chat events carry metadata and a reference only. Each message's text (or
//! attachment) lives in a content blob encrypted with its own random key,
//! outside the immutable log (#110), so deleting a message can delete its
//! content. An event holds the blob's 32-byte content hash (`blob_ref`) and
//! its 32-byte key; the text reaches Rust only when the host has fetched and
//! decrypted a blob and asks Rust to check it (`check_text`).
//!
//! Chat is not part of the KINS projection. It leaves the engine through
//! `kin_chat_page` (core.rs), like device names through `kin_device_names`.
//!
//! State is kept for fixed-size records in posting (replay) order, with the
//! decrypted texts in a separate append-only arena referenced by offset and
//! length. The arena lives on the engine instance, only while it is
//! unlocked (`kin_clear` drops it with everything else).
use std::collections::BTreeMap;

use crate::error::KinError;
use crate::event::{ActorId, ChatContentKind, ChatMessageId, DeviceId};

/// Most Unicode scalar values a message's text may have.
pub const MAX_CHAT_TEXT_CHARS: usize = 4_000;
pub const MAX_CHAT_TEXT_BYTES: usize = MAX_CHAT_TEXT_CHARS * 4;
/// Most messages one page returns.
pub const MAX_CHAT_PAGE: usize = 500;
/// Most events the chat log holds (history.rs): 100,000 messages with room
/// for their edits and deletions.
pub const MAX_CHAT_EVENT_COUNT: usize = 250_000;
/// Admins a page request may name.
pub const MAX_CHAT_ADMINS: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ChatMessageStatus {
    Live = 0,
    Edited = 1,
    /// Deleted by its author for everyone.
    Deleted = 2,
    /// Deleted for everyone by a household admin (decided at page time from
    /// the admins the host names; see `ChatState::removed_by_admin`).
    RemovedByAdmin = 3,
}

/// One message, as replay leaves it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatMessage {
    pub message_id: ChatMessageId,
    pub author: ActorId,
    pub device: DeviceId,
    pub posted_at: i64,
    /// 0 until the first edit.
    pub edited_at: i64,
    pub status: ChatMessageStatus,
    pub content_kind: ChatContentKind,
    /// The current content blob. Zero once deleted.
    pub blob_ref: [u8; 32],
    pub blob_key: [u8; 32],
}

/// The chat domain of a replay.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChatState {
    /// Messages in posting order.
    pub messages: Vec<ChatMessage>,
    pub positions: BTreeMap<ChatMessageId, usize>,
    /// Blobs no message refers to any more: replaced by an edit or deleted
    /// by the author. Hosts delete their local copies (#110).
    pub retired: Vec<[u8; 32]>,
    /// Admin deletions of other members' messages, by message: who claimed
    /// them, in replay order. Whether a claim counts depends on whether its
    /// author is an admin, which only the service knows, so the host names
    /// the household's admins when it reads a page.
    pub admin_claims: BTreeMap<ChatMessageId, Vec<ActorId>>,
}

impl ChatState {
    pub fn get(&self, message_id: &ChatMessageId) -> Option<&ChatMessage> {
        self.positions.get(message_id).map(|&at| &self.messages[at])
    }

    /// Whether one of `admins` deleted this message for everyone.
    pub fn removed_by_admin(&self, message_id: &ChatMessageId, admins: &[ActorId]) -> bool {
        self.admin_claims
            .get(message_id)
            .is_some_and(|claims| claims.iter().any(|actor| admins.contains(actor)))
    }
}

/// Checks a message's decrypted text: valid UTF-8, 1 to 4,000 Unicode scalar
/// values, not only whitespace, and no control characters other than tab
/// and line feed. Text is plain text and is never rendered as markup.
pub fn check_text(bytes: &[u8]) -> Result<&str, KinError> {
    if bytes.is_empty() || bytes.len() > MAX_CHAT_TEXT_BYTES {
        return Err(KinError::InvalidEvent);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| KinError::InvalidEvent)?;
    let mut chars = 0usize;
    for character in text.chars() {
        chars += 1;
        let control = character.is_control() && character != '\n' && character != '\t';
        if control || chars > MAX_CHAT_TEXT_CHARS {
            return Err(KinError::InvalidEvent);
        }
    }
    if text.trim().is_empty() {
        return Err(KinError::InvalidEvent);
    }
    Ok(text)
}

/// Decrypted message texts by blob, held only while the engine is unlocked.
/// One contiguous byte arena and an `(offset, length)` span per blob; a text
/// is stored once and never rewritten.
#[derive(Default)]
pub struct ChatTexts {
    bytes: Vec<u8>,
    spans: BTreeMap<[u8; 32], (u32, u32)>,
}

/// Most text the arena holds (a little over 1,000 full-length messages);
/// beyond it the arena starts again, and the host re-supplies texts.
pub const MAX_CHAT_ARENA_BYTES: usize = 16 * 1024 * 1024;

impl ChatTexts {
    pub const fn new() -> Self {
        Self {
            bytes: Vec::new(),
            spans: BTreeMap::new(),
        }
    }

    /// Checks and stores a blob's text. Storing the same blob again is a
    /// no-op (content-addressed: the text can't differ).
    pub fn put(&mut self, blob_ref: [u8; 32], text: &[u8]) -> Result<(), KinError> {
        if blob_ref == [0; 32] {
            return Err(KinError::MalformedProtocol);
        }
        check_text(text)?;
        if self.spans.contains_key(&blob_ref) {
            return Ok(());
        }
        if self.bytes.len() + text.len() > MAX_CHAT_ARENA_BYTES {
            self.clear();
        }
        let offset = u32::try_from(self.bytes.len()).map_err(|_| KinError::SizeLimit)?;
        self.bytes
            .try_reserve(text.len())
            .map_err(|_| KinError::SizeLimit)?;
        self.bytes.extend_from_slice(text);
        self.spans.insert(blob_ref, (offset, text.len() as u32));
        Ok(())
    }

    pub fn get(&self, blob_ref: &[u8; 32]) -> Option<&[u8]> {
        self.spans
            .get(blob_ref)
            .map(|&(offset, length)| &self.bytes[offset as usize..(offset + length) as usize])
    }

    /// Forgets a blob's text (its message was edited or deleted) and
    /// zero-fills its bytes, so a deleted message's text doesn't linger in
    /// the arena until the next `clear`. The span itself is not reused.
    pub fn forget(&mut self, blob_ref: &[u8; 32]) {
        if let Some((offset, length)) = self.spans.remove(blob_ref) {
            self.bytes[offset as usize..(offset + length) as usize].fill(0);
        }
    }

    /// Drops every text, zero-filling the arena first.
    pub fn clear(&mut self) {
        self.bytes.fill(0);
        self.bytes = Vec::new();
        self.spans.clear();
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }
}

/// KCHQ v1, a page request: "KCHQ", version u16 (1), reserved u16 (0),
/// before u32 (page ends before this index; u32::MAX for the newest),
/// limit u16 (1..=500), flags u8 (bit 0: include texts the arena holds;
/// bit 1: include retired blobs), reserved u8 (0), admin count u32 (at most
/// 16), then 16 bytes per admin actor ID, then the record-less KINE context.
pub struct PageRequest<'a> {
    pub before: u32,
    pub limit: usize,
    pub include_text: bool,
    pub include_retired: bool,
    pub admins: Vec<ActorId>,
    pub context: &'a [u8],
}

pub const PAGE_REQUEST_VERSION: u16 = 1;
pub const PAGE_VERSION: u16 = 1;
/// Bytes per message record in a KCHP page.
pub const PAGE_RECORD_BYTES: usize = 128;

pub fn decode_page_request(bytes: &[u8]) -> Result<PageRequest<'_>, KinError> {
    if bytes.len() < 20 || &bytes[..4] != b"KCHQ" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != PAGE_REQUEST_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    let flags = bytes[14];
    if bytes[6..8] != [0; 2] || bytes[15] != 0 || flags & !0b11 != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let before = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let limit = u16::from_le_bytes([bytes[12], bytes[13]]) as usize;
    let admin_count = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
    if limit == 0 || limit > MAX_CHAT_PAGE || admin_count > MAX_CHAT_ADMINS {
        return Err(KinError::MalformedProtocol);
    }
    let context_at = 20 + admin_count * 16;
    if bytes.len() < context_at {
        return Err(KinError::MalformedProtocol);
    }
    let admins = bytes[20..context_at]
        .chunks_exact(16)
        .map(|chunk| ActorId(chunk.try_into().unwrap()))
        .collect::<Vec<_>>();
    if admins.iter().any(|admin| admin.0 == [0; 16]) {
        return Err(KinError::MalformedProtocol);
    }
    Ok(PageRequest {
        before,
        limit,
        include_text: flags & 1 != 0,
        include_retired: flags & 2 != 0,
        admins,
        context: &bytes[context_at..],
    })
}

/// KCHP v1, a page: "KCHP", version u16 (1), reserved u16 (0), then u32s:
/// total messages, index of the page's first message, records in the page,
/// text bytes, retired blobs. Then 128 bytes per message, oldest first:
///
/// ```text
/// 0   message ID (16)        16  author (16)          32  posting device (16)
/// 48  posted at i64          56  edited at i64 (0)    64  index u32
/// 68  status u8              69  content kind u8      70  reserved u16
/// 72  blob ref (32)          104 text offset u32      108 text length u32
/// 112 reserved (16)
/// ```
///
/// The blob ref is zero for a deleted or removed message; a text length of
/// 0 means the arena doesn't hold that message's text (texts are never
/// empty). Then 32 bytes of blob key per message, in the same order (zero
/// for a deleted or removed message), then the text bytes, then 32 bytes
/// per retired blob.
pub fn encode_page(
    state: &ChatState,
    request: &PageRequest<'_>,
    texts: &ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let total = state.messages.len();
    let end = (request.before as usize).min(total);
    let start = end.saturating_sub(request.limit);
    let page = &state.messages[start..end];
    let status = |message: &ChatMessage| {
        if message.status != ChatMessageStatus::Deleted
            && state.removed_by_admin(&message.message_id, &request.admins)
        {
            ChatMessageStatus::RemovedByAdmin
        } else {
            message.status
        }
    };
    // Admin-removed messages' blobs are retired too, once the admins say so.
    let mut retired: Vec<[u8; 32]> = Vec::new();
    if request.include_retired {
        retired.extend_from_slice(&state.retired);
        for message in &state.messages {
            if message.blob_ref != [0; 32] && status(message) == ChatMessageStatus::RemovedByAdmin {
                retired.push(message.blob_ref);
            }
        }
    }
    let mut text_bytes = 0usize;
    if request.include_text {
        for message in page {
            if status(message) == ChatMessageStatus::Live
                || status(message) == ChatMessageStatus::Edited
            {
                text_bytes += texts.get(&message.blob_ref).map_or(0, <[u8]>::len);
            }
        }
    }
    let size = 28usize
        .checked_add(page.len() * (PAGE_RECORD_BYTES + 32))
        .and_then(|size| size.checked_add(text_bytes))
        .and_then(|size| size.checked_add(retired.len() * 32))
        .ok_or(KinError::SizeLimit)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KCHP");
    bytes.extend_from_slice(&PAGE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    for value in [total, start, page.len(), text_bytes, retired.len()] {
        bytes.extend_from_slice(
            &u32::try_from(value)
                .map_err(|_| KinError::SizeLimit)?
                .to_le_bytes(),
        );
    }
    let mut text_offset = 0u32;
    let mut text_spans = Vec::with_capacity(page.len());
    for (index, message) in page.iter().enumerate() {
        let shown = status(message);
        let visible = matches!(shown, ChatMessageStatus::Live | ChatMessageStatus::Edited);
        let text = if request.include_text && visible {
            texts.get(&message.blob_ref)
        } else {
            None
        };
        bytes.extend_from_slice(&message.message_id.0);
        bytes.extend_from_slice(&message.author.0);
        bytes.extend_from_slice(&message.device.0);
        bytes.extend_from_slice(&message.posted_at.to_le_bytes());
        bytes.extend_from_slice(&message.edited_at.to_le_bytes());
        bytes.extend_from_slice(&((start + index) as u32).to_le_bytes());
        bytes.push(shown as u8);
        bytes.push(message.content_kind as u8);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(if visible { &message.blob_ref } else { &[0; 32] });
        match text {
            Some(text) => {
                bytes.extend_from_slice(&text_offset.to_le_bytes());
                bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
                text_offset += text.len() as u32;
                text_spans.push(text);
            }
            None => bytes.extend_from_slice(&[0; 8]),
        }
        bytes.extend_from_slice(&[0; 16]);
    }
    for message in page {
        let visible = matches!(
            status(message),
            ChatMessageStatus::Live | ChatMessageStatus::Edited
        );
        bytes.extend_from_slice(if visible { &message.blob_key } else { &[0; 32] });
    }
    for text in text_spans {
        bytes.extend_from_slice(text);
    }
    for blob in &retired {
        bytes.extend_from_slice(blob);
    }
    debug_assert_eq!(bytes.len(), size);
    Ok(bytes)
}

/// KCHT v1, texts for the arena (`kin_chat_text`): "KCHT", version u16 (1),
/// reserved u16 (0), count u32 (1..=500), then per text: blob ref (32),
/// length u32, the UTF-8 text. The result, KCHS v1: "KCHS", version u16 (1),
/// reserved u16 (0), count u32, then one status byte per text in request
/// order: 0 stored (or already held), 1 rejected by `check_text`. A text is
/// checked alone, so one bad blob never keeps the rest of a page out.
pub fn put_texts(bytes: &[u8], texts: &mut ChatTexts) -> Result<Vec<u8>, KinError> {
    if bytes.len() < 12 || &bytes[..4] != b"KCHT" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if bytes[6..8] != [0; 2] || count == 0 || count > MAX_CHAT_PAGE {
        return Err(KinError::MalformedProtocol);
    }
    // Frame every entry before storing any, so a malformed request changes
    // nothing.
    let mut entries = Vec::with_capacity(count);
    let mut offset = 12usize;
    for _ in 0..count {
        let header = bytes
            .get(offset..offset + 36)
            .ok_or(KinError::MalformedProtocol)?;
        let blob_ref: [u8; 32] = header[..32].try_into().unwrap();
        let length = u32::from_le_bytes(header[32..36].try_into().unwrap()) as usize;
        let start = offset + 36;
        let end = start
            .checked_add(length)
            .ok_or(KinError::MalformedProtocol)?;
        if blob_ref == [0; 32] || length > MAX_CHAT_TEXT_BYTES || end > bytes.len() {
            return Err(KinError::MalformedProtocol);
        }
        entries.push((blob_ref, start..end));
        offset = end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    let mut output = Vec::with_capacity(12 + count);
    output.extend_from_slice(b"KCHS\x01\0\0\0");
    output.extend_from_slice(&(count as u32).to_le_bytes());
    for (blob_ref, range) in entries {
        output.push(match texts.put(blob_ref, &bytes[range]) {
            Ok(()) => 0,
            Err(KinError::InvalidEvent) => 1,
            Err(error) => return Err(error),
        });
    }
    Ok(output)
}
