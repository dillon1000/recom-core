//! Locks native proposal determinism to a fixed 12×12 graph, four-district starting plan, and seed.
//! The assignment is hashed as little-endian u16 bytes and also reproduced by a second independent
//! chain so accidental RNG or iteration-order drift fails immediately.

mod common;

use recom_core::{Chain, ChainParams};
use sha2::{Digest, Sha256};

use common::{grid_graph, row_stripes};

#[test]
fn fixed_seed_matches_golden_assignment_hash() {
    let first = run_chain();
    let second = run_chain();
    assert_eq!(first, second);
    let hash = assignment_hash(&first);
    assert_eq!(
        hash,
        "0c8de06eface48e3f7f8556ab58ebcd0ef9e8d2a0037523cf8a0677d593f5c8c"
    );
}

fn run_chain() -> Vec<u16> {
    let graph = grid_graph(12, 12, false);
    let initial = row_stripes(12, 12, 4);
    let mut chain = Chain::new(
        graph,
        vec![1; 144],
        ChainParams {
            districts: 4,
            seed: 0x5eed_cafe_2026_0712,
            pop_tolerance: 0.05,
            county_surcharge: 10,
            tree_attempts: 12,
            frozen_districts: Vec::new(),
        },
        Some(initial),
    )
    .expect("golden fixture is valid");
    chain.step(250);
    chain.assignment().to_vec()
}

fn assignment_hash(assignment: &[u16]) -> String {
    let bytes = assignment
        .iter()
        .flat_map(|district| district.to_le_bytes())
        .collect::<Vec<_>>();
    format!("{:x}", Sha256::digest(bytes))
}
