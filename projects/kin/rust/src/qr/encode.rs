//! Byte-mode QR encoder, level M, versions 1–10. Every stage writes into
//! preallocated, exact-size buffers; nothing is parsed or re-decoded.

use super::{
    layout::{self, Grid},
    rs, tables, QrError,
};

/// A finished symbol: `size` × `size` modules, one byte each (1 = dark).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub size: usize,
    pub dark: Vec<u8>,
}

/// The longest byte payload that fits version 10 at level M.
pub const MAX_BYTES: usize = 213;

/// Encodes `data` (any bytes; Kin passes UTF-8 text) as a QR symbol.
pub fn encode(data: &[u8]) -> Result<Code, QrError> {
    if data.is_empty() {
        return Err(QrError::Empty);
    }
    let version = choose_version(data.len())?;
    let codewords = codewords(data, version);
    let mut grid = Grid::with_function_patterns(version);
    let order = grid.data_order();
    let total_bits = codewords.len() * 8;
    for (position, &index) in order.iter().enumerate().take(total_bits) {
        grid.dark[index] = (codewords[position / 8] >> (7 - position % 8)) & 1;
    }
    // Remainder modules (beyond `total_bits`) stay light.
    let size = grid.size;
    let mut best: Option<(u32, Vec<u8>)> = None;
    for mask in 0..8u8 {
        let mut candidate = grid.dark.clone();
        for &index in &order {
            if layout::mask_applies(mask, index / size, index % size) {
                candidate[index] ^= 1;
            }
        }
        let mut masked = Grid {
            size,
            dark: candidate,
            reserved: grid.reserved.clone(),
        };
        masked.write_format(layout::format_bits(mask));
        let score = layout::penalty(&masked.dark, size);
        if best.as_ref().is_none_or(|(lowest, _)| score < *lowest) {
            best = Some((score, masked.dark));
        }
    }
    let (_, dark) = best.expect("eight masks are always evaluated");
    Ok(Code { size, dark })
}

/// The smallest version whose byte-mode capacity holds `length` bytes.
fn choose_version(length: usize) -> Result<usize, QrError> {
    for version in 1..=10 {
        let capacity_bits = tables::DATA_CODEWORDS[version - 1] * 8;
        let needed = 4 + tables::count_bits(version) + 8 * length;
        if needed <= capacity_bits {
            return Ok(version);
        }
    }
    Err(QrError::TooLong)
}

/// Data codewords, then the interleaved data and error-correction codewords.
fn codewords(data: &[u8], version: usize) -> Vec<u8> {
    let capacity = tables::DATA_CODEWORDS[version - 1];
    let mut bits = BitWriter::with_capacity(capacity);
    bits.push(0b0100, 4); // byte mode
    bits.push(data.len() as u32, tables::count_bits(version));
    for &byte in data {
        bits.push(u32::from(byte), 8);
    }
    let terminator = (capacity * 8 - bits.len()).min(4);
    bits.push(0, terminator);
    bits.pad_to_byte();
    let mut stream = bits.into_bytes();
    let mut pad = [0xEC, 0x11].into_iter().cycle();
    while stream.len() < capacity {
        stream.push(pad.next().expect("cycle never ends"));
    }

    // Split into blocks, compute each block's check codewords.
    let lengths = tables::block_data_lengths(version);
    let check_length = tables::EC_PER_BLOCK[version - 1];
    let mut blocks: Vec<&[u8]> = Vec::with_capacity(lengths.len());
    let mut offset = 0;
    for &length in &lengths {
        blocks.push(&stream[offset..offset + length]);
        offset += length;
    }
    let checks: Vec<Vec<u8>> = blocks
        .iter()
        .map(|block| rs::encode(block, check_length))
        .collect();

    let mut out = Vec::with_capacity(capacity + lengths.len() * check_length);
    let longest = lengths.iter().copied().max().unwrap_or(0);
    for i in 0..longest {
        for block in &blocks {
            if let Some(&byte) = block.get(i) {
                out.push(byte);
            }
        }
    }
    for i in 0..check_length {
        for check in &checks {
            out.push(check[i]);
        }
    }
    out
}

/// Packs bit fields most significant bit first.
struct BitWriter {
    bytes: Vec<u8>,
    bits: usize,
}

impl BitWriter {
    fn with_capacity(bytes: usize) -> BitWriter {
        BitWriter {
            bytes: Vec::with_capacity(bytes),
            bits: 0,
        }
    }

    fn len(&self) -> usize {
        self.bits
    }

    fn push(&mut self, value: u32, width: usize) {
        for shift in (0..width).rev() {
            if self.bits.is_multiple_of(8) {
                self.bytes.push(0);
            }
            let bit = ((value >> shift) & 1) as u8;
            let last = self.bytes.len() - 1;
            self.bytes[last] |= bit << (7 - self.bits % 8);
            self.bits += 1;
        }
    }

    fn pad_to_byte(&mut self) {
        if !self.bits.is_multiple_of(8) {
            self.bits += 8 - self.bits % 8;
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_grow_with_the_payload() {
        assert_eq!(choose_version(1), Ok(1));
        assert_eq!(choose_version(17), Ok(2));
        assert_eq!(choose_version(MAX_BYTES), Ok(10));
        assert_eq!(choose_version(MAX_BYTES + 1), Err(QrError::TooLong));
    }

    #[test]
    fn symbol_sizes_follow_the_version() {
        assert_eq!(encode(b"A").unwrap().size, 21);
        let long = vec![b'k'; 120];
        assert_eq!(encode(&long).unwrap().size, 17 + 4 * 7);
        assert_eq!(encode(&[]).unwrap_err(), QrError::Empty);
    }

    #[test]
    fn the_always_dark_module_and_finder_corners_are_drawn() {
        let code = encode(b"https://example.org/#abc").unwrap();
        let size = code.size;
        assert_eq!(code.dark[(size - 8) * size + 8], 1, "dark module");
        assert_eq!(code.dark[0], 1, "finder corner");
    }
}
