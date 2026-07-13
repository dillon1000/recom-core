//! Exercises the no-initial-assignment path and constructor validation. Generated plans must expose
//! every requested district, remain contiguous, and meet tolerance before the first chain step.

mod common;

use recom_core::{Chain, ChainParams, CsrGraph};

use common::{assert_partition_invariants, grid_graph};

#[test]
fn seed_and_grow_builds_a_legal_balanced_plan() {
    let graph = grid_graph(8, 8, false);
    let populations = vec![100_u32; graph.node_count()];
    let chain = Chain::new(
        graph.clone(),
        populations.clone(),
        ChainParams {
            districts: 4,
            seed: 42,
            pop_tolerance: 0.01,
            county_surcharge: 0,
            tree_attempts: 10,
            frozen_districts: Vec::new(),
        },
        None,
    )
    .expect("uniform grid has an exact four-way seed plan");
    assert_partition_invariants(&graph, &populations, chain.assignment(), 4, 0.01);
}

#[test]
fn graph_validation_rejects_disconnected_input() {
    let result = CsrGraph::new(vec![0, 0, 0], Vec::new(), Vec::new(), None);
    assert!(result.is_err());
}

#[test]
fn chain_rejects_zero_population_targets() {
    let graph = grid_graph(2, 2, false);
    let result = Chain::new(
        graph,
        vec![0; 4],
        ChainParams {
            districts: 2,
            seed: 1,
            pop_tolerance: 0.1,
            county_surcharge: 0,
            tree_attempts: 1,
            frozen_districts: Vec::new(),
        },
        Some(vec![0, 0, 1, 1]),
    );
    assert!(result.is_err());
}
