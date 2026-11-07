//! Seeded PRNG. MUST match client/js/prng.js exactly.
//!
//! - `seed_from_key`: FNV-1a (32-bit) over the UTF-8 bytes of the key string.
//! - `Mulberry32`: the classic mulberry32 generator.
//! - `next_f64` = next_u32 / 2^32, in [0, 1). Consumers cast to f32 when writing buffers.

pub fn seed_from_key(key: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in key.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

pub struct Mulberry32 {
    s: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { s: seed }
    }

    pub fn from_key(key: &str) -> Self {
        Self::new(seed_from_key(key))
    }

    pub fn next_u32(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x6D2B79F5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    pub fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }

    /// Uniform in [-1, 1).
    pub fn next_bipolar(&mut self) -> f64 {
        self.next_f64() * 2.0 - 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_known_values() {
        assert_eq!(seed_from_key(""), 0x811c9dc5);
        assert_eq!(seed_from_key("a"), 0xe40c292c);
    }

    #[test]
    fn mulberry_is_deterministic() {
        let mut a = Mulberry32::new(1);
        let mut b = Mulberry32::new(1);
        for _ in 0..100 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }
}
