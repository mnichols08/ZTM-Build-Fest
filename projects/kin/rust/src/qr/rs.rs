//! Reed–Solomon over GF(256) for QR codes (primitive polynomial 0x11D,
//! generator roots α^0 … α^(n-1)). Tables are built at compile time, so the
//! runtime has no allocation-heavy setup and no dependency.

const fn build_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut value: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = value as u8;
        log[value as usize] = i as u8;
        value <<= 1;
        if value & 0x100 != 0 {
            value ^= 0x11D;
        }
        i += 1;
    }
    // Doubled so that log(a) + log(b) never needs a modulo.
    let mut i = 255;
    while i < 512 {
        exp[i] = exp[i - 255];
        i += 1;
    }
    (exp, log)
}

const TABLES: ([u8; 512], [u8; 256]) = build_tables();
const EXP: [u8; 512] = TABLES.0;
const LOG: [u8; 256] = TABLES.1;

pub fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        EXP[LOG[a as usize] as usize + LOG[b as usize] as usize]
    }
}

pub fn inv(a: u8) -> u8 {
    debug_assert!(a != 0, "zero has no inverse");
    EXP[255 - LOG[a as usize] as usize]
}

/// α^power, for any non-negative power.
pub fn exp(power: usize) -> u8 {
    EXP[power % 255]
}

/// The generator polynomial of degree `n`, highest coefficient first.
fn generator(n: usize) -> Vec<u8> {
    let mut poly = vec![1u8];
    for i in 0..n {
        // Multiply by (x + α^i).
        let root = exp(i);
        let mut next = vec![0u8; poly.len() + 1];
        for (j, &coefficient) in poly.iter().enumerate() {
            next[j] ^= coefficient;
            next[j + 1] ^= mul(coefficient, root);
        }
        poly = next;
    }
    poly
}

/// The `n` error-correction codewords for `data`.
pub fn encode(data: &[u8], n: usize) -> Vec<u8> {
    let generator = generator(n);
    let mut remainder = vec![0u8; n];
    for &byte in data {
        let factor = byte ^ remainder[0];
        remainder.rotate_left(1);
        remainder[n - 1] = 0;
        for (slot, &g) in remainder.iter_mut().zip(&generator[1..]) {
            *slot ^= mul(g, factor);
        }
    }
    remainder
}

/// Corrects `codeword` (data followed by `n` check codewords) in place.
/// Returns the number of corrected symbols, or `None` when there are more
/// errors than the code can correct (`n / 2`).
pub fn correct(codeword: &mut [u8], n: usize) -> Option<usize> {
    let length = codeword.len();
    // Syndromes S_j = c(α^j).
    let syndromes: Vec<u8> = (0..n)
        .map(|j| codeword.iter().fold(0u8, |acc, &c| mul(acc, exp(j)) ^ c))
        .collect();
    if syndromes.iter().all(|&s| s == 0) {
        return Some(0);
    }
    // Berlekamp–Massey: the error locator Λ, lowest coefficient first.
    let mut lambda = vec![1u8];
    let mut previous = vec![1u8];
    let mut errors = 0usize;
    let mut shift = 1usize;
    let mut previous_discrepancy = 1u8;
    for k in 0..n {
        let mut discrepancy = syndromes[k];
        for i in 1..=errors.min(lambda.len() - 1).min(k) {
            discrepancy ^= mul(lambda[i], syndromes[k - i]);
        }
        if discrepancy == 0 {
            shift += 1;
            continue;
        }
        let scale = mul(discrepancy, inv(previous_discrepancy));
        let mut next = lambda.clone();
        if next.len() < previous.len() + shift {
            next.resize(previous.len() + shift, 0);
        }
        for (i, &p) in previous.iter().enumerate() {
            next[i + shift] ^= mul(scale, p);
        }
        if 2 * errors <= k {
            errors = k + 1 - errors;
            previous = lambda;
            previous_discrepancy = discrepancy;
            shift = 1;
        } else {
            shift += 1;
        }
        lambda = next;
    }
    lambda.resize(errors + 1, 0);
    if errors == 0 || errors > n / 2 {
        return None;
    }
    // Chien search: position p (power of x) is in error when Λ(α^-p) = 0.
    let mut positions = Vec::with_capacity(errors);
    for index in 0..length {
        let power = length - 1 - index;
        let x = exp((255 - power % 255) % 255);
        let value = lambda.iter().rev().fold(0u8, |acc, &c| mul(acc, x) ^ c);
        if value == 0 {
            positions.push((index, power));
        }
    }
    if positions.len() != errors {
        return None;
    }
    // Forney: Ω = S·Λ mod x^n, then the magnitudes (first root α^0).
    let mut omega = vec![0u8; n];
    for (i, &l) in lambda.iter().enumerate() {
        for (j, &s) in syndromes.iter().enumerate() {
            if i + j < n {
                omega[i + j] ^= mul(l, s);
            }
        }
    }
    for &(index, power) in &positions {
        let x = exp(power); // X_k
        let x_inverse = exp((255 - power % 255) % 255);
        let omega_value = omega
            .iter()
            .rev()
            .fold(0u8, |acc, &c| mul(acc, x_inverse) ^ c);
        // Formal derivative: only odd-power terms survive in characteristic 2.
        let derivative = (1..lambda.len())
            .step_by(2)
            .fold(0u8, |acc, i| acc ^ mul(lambda[i], pow(x_inverse, i - 1)));
        if derivative == 0 {
            return None;
        }
        codeword[index] ^= mul(x, mul(omega_value, inv(derivative)));
    }
    // A correction that doesn't yield a valid codeword means it failed.
    let check = (0..n).all(|j| codeword.iter().fold(0u8, |acc, &c| mul(acc, exp(j)) ^ c) == 0);
    check.then_some(errors)
}

fn pow(base: u8, power: usize) -> u8 {
    (0..power).fold(1u8, |acc, _| mul(acc, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_inverse_and_generator_roots() {
        for a in 1..=255u8 {
            assert_eq!(mul(a, inv(a)), 1);
        }
        assert_eq!(exp(255), 1, "α has order 255");
    }

    #[test]
    fn corrects_up_to_half_the_check_symbols() {
        let data: Vec<u8> = (0..26u8)
            .map(|i| i.wrapping_mul(37).wrapping_add(11))
            .collect();
        let check = encode(&data, 10);
        let mut codeword = data.clone();
        codeword.extend(&check);
        let original = codeword.clone();
        assert_eq!(correct(&mut codeword, 10), Some(0));
        for (k, position) in [0usize, 5, 17, 30, 35].iter().enumerate() {
            codeword[*position] ^= (k as u8).wrapping_mul(91).wrapping_add(7).max(1);
        }
        assert_eq!(correct(&mut codeword, 10), Some(5));
        assert_eq!(codeword, original);
    }

    #[test]
    fn refuses_more_errors_than_it_can_correct() {
        let data: Vec<u8> = (1..=16u8).collect();
        let mut codeword = data.clone();
        codeword.extend(encode(&data, 10));
        for position in 0..6 {
            codeword[position * 3] ^= 0x5A;
        }
        assert_eq!(correct(&mut codeword, 10), None);
    }
}
