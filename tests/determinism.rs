//! Locks native proposal determinism to a fixed 12×12 graph, four-district starting plan, and seed.
//! The assignment is hashed as little-endian u16 bytes and also reproduced by a second independent
//! chain so accidental RNG or iteration-order drift fails immediately.

mod common;

use recom_core::{Chain, ChainParams};
use sha2::{Digest, Sha256};

use common::{grid_graph, row_stripes};

#[test]
fn fixed_seed_matches_golden_assignment_hash() {
    let first = run_chain(0);
    let second = run_chain(0);
    assert_eq!(first, second);
    let hash = assignment_hash(&first);
    assert_eq!(
        hash,
        "3996a810276a54e6cb0c55ff75f31ba1b080e5bc964d751a7eb47f851bedf9fd"
    );
}

#[test]
fn short_bursts_match_golden_assignment_hash() {
    let first = run_chain(25);
    let second = run_chain(25);
    assert_eq!(first, second);
    let hash = assignment_hash(&first);
    assert_eq!(
        hash,
        "f58c25095f16c1d314883508b57c3fefe80b1522d5fb2fe08f172e8a343a2dca"
    );
}

fn run_chain(burst_length: u32) -> Vec<u16> {
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
            burst_length,
            frozen_districts: Vec::new(),
            variant: Default::default(),
            balance_ub: 0,
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
