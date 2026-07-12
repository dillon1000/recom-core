//! Verifies that the finishing pass moves only border units, preserves district connectivity, and
//! strictly improves maximum deviation until a tighter feasible tolerance is reached.

mod common;

use recom_core::{Chain, ChainParams};

use common::{assert_partition_invariants, line_graph};

#[test]
fn rebalance_reduces_maximum_population_deviation() {
    let graph = line_graph(4);
    let populations = vec![10_u32; 4];
    let mut chain = Chain::new(
        graph.clone(),
        populations.clone(),
        ChainParams {
            districts: 2,
            seed: 7,
            pop_tolerance: 0.5,
            county_surcharge: 0,
            tree_attempts: 4,
            frozen_districts: Vec::new(),
        },
        Some(vec![0, 0, 0, 1]),
    )
    .expect("initial plan is valid at relaxed tolerance");
    let before = maximum_deviation(chain.district_populations());
    let result = chain.rebalance(0.01).expect("tolerance is valid");
    let after = maximum_deviation(chain.district_populations());
    assert!(after < before);
    assert!(result.achieved_tolerance);
    assert_eq!(result.moves, 1);
    assert_partition_invariants(&graph, &populations, chain.assignment(), 2, 0.01);
}

#[test]
fn rebalance_keeps_frozen_district_unchanged() {
    let graph = line_graph(4);
    let mut chain = Chain::new(
        graph,
        vec![10; 4],
        ChainParams {
            districts: 2,
            seed: 9,
            pop_tolerance: 0.5,
            county_surcharge: 0,
            tree_attempts: 4,
            frozen_districts: vec![0],
        },
        Some(vec![0, 0, 0, 1]),
    )
    .expect("initial plan is valid");
    let before = chain.assignment().to_vec();
    let result = chain.rebalance(0.01).expect("tolerance is valid");
    assert!(!result.achieved_tolerance);
    assert_eq!(chain.assignment(), before);
}

fn maximum_deviation(populations: &[u64]) -> u64 {
    let total = populations.iter().sum::<u64>();
    populations
        .iter()
        .map(|population| (population * populations.len() as u64).abs_diff(total))
        .max()
        .unwrap_or_default()
}
