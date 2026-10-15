//! The canonical event history one engine instance holds.
//!
//! The host keeps the same history in its session arena (event-arena.js) and
//! sends Rust only what changed: `kin_history_append` adds records after the
//! ones already held, `kin_history_truncate` drops records from the end, and
//! `kin_history_reset` empties it. Projections and commands then replay this
//! history instead of receiving it whole in every request.
//!
//! Records are stored exactly as received: one contiguous byte buffer and an
//! `(offset, length)` span per record, in local arrival order. Each record is
//! checked when it is appended; replay decodes them again (zero-copy decoding
//! is a later slice).
//!
//! Append batch layout: u32 record count, then one u32 length per record,
//! then the records' bytes back to back.
use crate::error::KinError;
use crate::event_decode::decode_event;
use crate::request::DecodedRequest;
use crate::wire::{read_u32, MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};

pub struct History {
    bytes: Vec<u8>,
    spans: Vec<(u32, u32)>,
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

impl History {
    pub const fn new() -> Self {
        Self {
            bytes: Vec::new(),
            spans: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    pub fn records(&self) -> impl Iterator<Item = &[u8]> {
        self.spans
            .iter()
            .map(|&(offset, length)| &self.bytes[offset as usize..(offset + length) as usize])
    }

    /// Appends a batch after the records already held. The whole batch is
    /// checked first, so a bad record leaves the history unchanged.
    pub fn append(&mut self, batch: &[u8]) -> Result<(), KinError> {
        let count = read_u32(batch, 0)? as usize;
        let total = self.len().checked_add(count).ok_or(KinError::SizeLimit)?;
        if total > MAX_EVENT_COUNT {
            return Err(KinError::SizeLimit);
        }
        let table_end = count
            .checked_mul(4)
            .and_then(|bytes| bytes.checked_add(4))
            .ok_or(KinError::MalformedProtocol)?;
        if table_end > batch.len() {
            return Err(KinError::MalformedProtocol);
        }
        let mut lengths = Vec::new();
        lengths
            .try_reserve_exact(count)
            .map_err(|_| KinError::SizeLimit)?;
        let mut offset = table_end;
        for index in 0..count {
            let length = read_u32(batch, 4 + index * 4)? as usize;
            let end = offset
                .checked_add(length)
                .ok_or(KinError::MalformedProtocol)?;
            let record = batch.get(offset..end).ok_or(KinError::MalformedProtocol)?;
            decode_event(record)?;
            lengths.push(length);
            offset = end;
        }
        if offset != batch.len() {
            return Err(KinError::MalformedProtocol);
        }
        let added = batch.len() - table_end;
        if self.bytes.len().saturating_add(added) > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        if self.bytes.capacity() - self.bytes.len() < added {
            // Reserve an eighth more than the history will hold, so the next
            // appends of a few events copy nothing, without the default
            // doubling, which would reserve a second full history.
            let headroom = added + (self.bytes.len() + added) / 8;
            self.bytes
                .try_reserve_exact(headroom)
                .map_err(|_| KinError::SizeLimit)?;
        }
        self.spans
            .try_reserve(count)
            .map_err(|_| KinError::SizeLimit)?;
        let mut start = self.bytes.len();
        self.bytes.extend_from_slice(&batch[table_end..]);
        for length in lengths {
            // Bounded by MAX_PROTOCOL_BYTES, so offsets and lengths fit in u32.
            self.spans.push((start as u32, length as u32));
            start += length;
        }
        Ok(())
    }

    /// Keeps the first `count` records.
    pub fn truncate(&mut self, count: usize) -> Result<(), KinError> {
        if count > self.len() {
            return Err(KinError::InvalidAbi);
        }
        let end = self
            .spans
            .get(count)
            .map_or(self.bytes.len(), |&(offset, _)| offset as usize);
        self.bytes[end..].fill(0);
        self.bytes.truncate(end);
        self.spans.truncate(count);
        Ok(())
    }

    /// Empties the history, zero-filling its bytes before releasing them.
    /// (Zero-filling covers this buffer only; it is no erasure guarantee.)
    pub fn clear(&mut self) {
        self.bytes.fill(0);
        self.bytes = Vec::new();
        self.spans = Vec::new();
    }

    /// `context` (from a record-less KINE request) with this history's events.
    pub fn request(&self, mut context: DecodedRequest) -> Result<DecodedRequest, KinError> {
        context
            .events
            .try_reserve_exact(self.len())
            .map_err(|_| KinError::SizeLimit)?;
        for record in self.records() {
            context.push_record(record)?;
        }
        Ok(context)
    }
}
