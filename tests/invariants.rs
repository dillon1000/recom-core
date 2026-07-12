//! Property-tests ReCom proposals on grid and planar-like triangulated graphs. Every accepted step
//! is checked independently for dense valid labels, nonempty contiguous districts, and population
//! totals inside the exact tolerance used to construct the chain.

mod common;

use proptest::prelude::*;
use recom_core::{Chain, ChainParams};

use common::{assert_partition_invariants, grid_graph, row_stripes};

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 24,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn accepted_steps_preserve_grid_invariants(
        width in 3_usize..7,
        rows_per_district in 2_usize..5,
        districts in 2_u16..5,
        seed in any::<u64>(),
    ) {
        run_invariant_case(width, rows_per_district, districts, seed, false);
    }

    #[test]
    fn accepted_steps_preserve_planar_like_invariants(
        width in 3_usize..7,
        rows_per_district in 2_usize..5,
        districts in 2_u16..5,
        seed in any::<u64>(),
    ) {
        run_invariant_case(width, rows_per_district, districts, seed, true);
    }
}

fn run_invariant_case(
    width: usize,
    rows_per_district: usize,
    districts: u16,
    seed: u64,
    add_diagonals: bool,
) {
    let height = rows_per_district * districts as usize;
    let graph = grid_graph(width, height, add_diagonals);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(width, height, districts);
    let tolerance = 0.25;
    let mut chain = Chain::new(
        graph.clone(),
        populations.clone(),
        ChainParams {
            districts,
            seed,
            pop_tolerance: tolerance,
            county_surcharge: 10_000,
            tree_attempts: 8,
            frozen_districts: Vec::new(),
        },
        Some(initial),
    )
    .expect("balanced stripe partition is valid");
    let mut accepted = 0;
    for _ in 0..60 {
        let status = chain.step(1);
        if status.steps_accepted > accepted {
            assert_partition_invariants(
                &graph,
                &populations,
                chain.assignment(),
                districts,
                tolerance,
            );
            accepted = status.steps_accepted;
        }
    }
}
