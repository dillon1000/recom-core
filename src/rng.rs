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

    pub(crate) fn edge_key(&mut self, county_cross: bool, preservation: u32) -> u64 {
        let random = u64::from(self.0.next_u32());
        random
            + if county_cross {
                county_crossing_penalty(preservation)
            } else {
                0
            }
    }

    pub(crate) fn accept(&mut self, numerator: u64, denominator: u64) -> bool {
        let draw = self.0.next_u64();
        u128::from(draw) * u128::from(denominator) < u128::from(numerator) << 64
    }
}

/// Maps the public 0–50 preference onto the same 32-bit range as the random edge key. At 50,
/// within-county edges always sort before county-crossing edges when a spanning tree permits it.
fn county_crossing_penalty(preservation: u32) -> u64 {
    u64::from(u32::MAX) * u64::from(preservation)
        / u64::from(recom_scoring::MAX_COUNTY_PRESERVATION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn county_preservation_spans_the_random_key_range() {
        assert_eq!(county_crossing_penalty(0), 0);
        assert_eq!(county_crossing_penalty(25), u64::from(u32::MAX) / 2);
        assert_eq!(county_crossing_penalty(50), u64::from(u32::MAX));

        let mut plain = ChainRng::new(42);
        let mut preserved = ChainRng::new(42);
        assert_eq!(
            preserved.edge_key(true, 50) - plain.edge_key(true, 0),
            u64::from(u32::MAX)
        );
    }

    #[test]
    fn integer_acceptance_handles_probability_edges() {
        for seed in 0..128 {
            assert!(ChainRng::new(seed).accept(7, 7));
            assert!(ChainRng::new(seed).accept(8, 7));
            assert!(!ChainRng::new(seed).accept(0, 7));
        }
    }
}
