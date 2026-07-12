//! Owns the pinned ChaCha8 random stream and integer edge-key generation. The seed is the only
//! mutable input, and all consumers draw through this wrapper so native and WASM proposal ordering
//! stays byte-for-byte reproducible.

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

#[derive(Debug, Clone)]
pub(crate) struct ChainRng(ChaCha8Rng);

impl ChainRng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(ChaCha8Rng::seed_from_u64(seed))
    }

    pub(crate) fn index(&mut self, upper_exclusive: usize) -> usize {
        debug_assert!(upper_exclusive > 0);
        let zone = u64::MAX - (u64::MAX % upper_exclusive as u64);
        loop {
            let value = self.0.next_u64();
            if value < zone {
                return (value % upper_exclusive as u64) as usize;
            }
        }
    }

    pub(crate) fn coin(&mut self) -> bool {
        self.0.next_u32() & 1 == 1
    }

    pub(crate) fn edge_key(&mut self, county_cross: bool, surcharge: u64) -> u64 {
        u64::from(self.0.next_u32()).saturating_add(if county_cross { surcharge } else { 0 })
    }
}
