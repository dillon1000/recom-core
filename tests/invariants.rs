//! Property-tests ReCom proposals on grid and planar-like triangulated graphs. Every accepted step
//! is checked independently for dense valid labels, nonempty contiguous districts, and population
//! totals inside the exact tolerance used to construct the chain.

mod common;

use proptest::prelude::*;
use recom_core::{Chain, ChainParams, CsrGraph, Partition, PopulationBounds, ProposalOutcome};

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
            county_surcharge: 10,
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
            assert_eq!(status.current_score, chain.full_recompute_score());
            accepted = status.steps_accepted;
        }
    }
}

#[test]
fn frontier_entries_are_nondominated_and_rescore_exactly() {
    let graph = grid_graph(8, 12, false);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(8, 12, 4);
    let tolerance = 0.25;
    let bounds = PopulationBounds::new(96, 4, tolerance).expect("bounds are valid");
    let mut chain = Chain::new(
        graph.clone(),
        populations.clone(),
        ChainParams {
            districts: 4,
            seed: 0xfeed_2026,
            pop_tolerance: tolerance,
            county_surcharge: 10,
            tree_attempts: 8,
            frozen_districts: Vec::new(),
        },
        Some(initial),
    )
    .expect("fixture is valid");
    chain.step(500);

    let frontier = chain.frontier();
    assert!(!frontier.is_empty());
    assert!(frontier.len() <= 24);
    for (index, entry) in frontier.iter().enumerate() {
        let rescored = Partition::new(&graph, &populations, entry.assignment.clone(), 4, bounds)
            .expect("frontier assignment remains valid")
            .score();
        assert_eq!(entry.score, rescored);
        for other in frontier.iter().skip(index + 1) {
            assert!(!entry.score.dominates(other.score));
            assert!(!other.score.dominates(entry.score));
            assert_ne!(entry.score.objective_tuple(), other.score.objective_tuple());
        }
    }
}

#[test]
fn full_score_is_invariant_under_district_relabeling() {
    let graph = grid_graph(4, 4, false);
    let populations = vec![1_u32; graph.node_count()];
    let assignment = row_stripes(4, 4, 4);
    let relabeled = assignment.iter().map(|district| 3 - district).collect();
    let bounds = PopulationBounds::new(16, 4, 0.01).expect("bounds are valid");
    let first = Partition::new(&graph, &populations, assignment, 4, bounds)
        .expect("fixture is valid")
        .score();
    let second = Partition::new(&graph, &populations, relabeled, 4, bounds)
        .expect("relabeling is valid")
        .score();
    assert_eq!(first, second);
}

#[test]
fn optional_edge_weights_change_weighted_cut_only() {
    let offsets = vec![0, 1, 3, 5, 6];
    let neighbors = vec![1, 0, 2, 1, 3, 2];
    let county_flags = vec![0; neighbors.len()];
    let default_graph = CsrGraph::new(
        offsets.clone(),
        neighbors.clone(),
        county_flags.clone(),
        None,
    )
    .expect("default graph is valid");
    let weighted_graph = CsrGraph::new(
        offsets,
        neighbors,
        county_flags,
        Some(vec![2, 2, 7, 7, 11, 11]),
    )
    .expect("weighted graph is valid");
    let populations = vec![1_u32; 4];
    let assignment = vec![0, 0, 1, 1];
    let bounds = PopulationBounds::new(4, 2, 0.01).expect("bounds are valid");
    let default_score = Partition::new(&default_graph, &populations, assignment.clone(), 2, bounds)
        .expect("partition is valid")
        .score();
    let weighted_score = Partition::new(&weighted_graph, &populations, assignment, 2, bounds)
        .expect("partition is valid")
        .score();
    assert_eq!(default_score.weighted_cut, 1);
    assert_eq!(weighted_score.weighted_cut, 7);
    assert_eq!(
        default_score.county_fragments,
        weighted_score.county_fragments
    );
    assert_eq!(default_score.county_splits, weighted_score.county_splits);
    assert_eq!(
        default_score.max_deviation_ppm,
        weighted_score.max_deviation_ppm
    );
}

#[test]
fn graph_rejects_misaligned_or_asymmetric_weights() {
    let offsets = vec![0, 1, 2];
    let neighbors = vec![1, 0];
    let county_flags = vec![0, 0];
    assert!(CsrGraph::new(
        offsets.clone(),
        neighbors.clone(),
        county_flags.clone(),
        Some(vec![3]),
    )
    .is_err());
    assert!(CsrGraph::new(offsets, neighbors, county_flags, Some(vec![3, 4])).is_err());
}

#[test]
fn county_preservation_changes_generation_and_optimized_selection() {
    let graph = grid_graph(8, 12, false);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(8, 12, 4);
    let run = |county_surcharge| {
        let mut chain = Chain::new(
            graph.clone(),
            populations.clone(),
            ChainParams {
                districts: 4,
                seed: 0x2026_0712,
                pop_tolerance: 0.25,
                county_surcharge,
                tree_attempts: 8,
                frozen_districts: Vec::new(),
            },
            Some(initial.clone()),
        )
        .expect("fixture is valid");
        chain.step(500);
        (chain.assignment().to_vec(), chain.status().best_score)
    };

    let (neutral_assignment, neutral_best) = run(0);
    let (preserved_assignment, preserved_best) = run(50);
    assert_ne!(neutral_assignment, preserved_assignment);
    assert!(preserved_best.county_fragments < neutral_best.county_fragments);
}

#[test]
fn county_preservation_rejects_values_above_the_public_range() {
    let graph = grid_graph(4, 4, false);
    let result = Chain::new(
        graph,
        vec![1_u32; 16],
        ChainParams {
            districts: 2,
            seed: 42,
            pop_tolerance: 0.25,
            county_surcharge: 51,
            tree_attempts: 2,
            frozen_districts: Vec::new(),
        },
        Some(row_stripes(4, 4, 2)),
    );
    assert!(result.is_err());
}

#[test]
fn proposal_trace_reconstructs_every_accepted_change() {
    let graph = grid_graph(8, 12, false);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(8, 12, 4);
    let params = ChainParams {
        districts: 4,
        seed: 0x51a7_e2026,
        pop_tolerance: 0.25,
        county_surcharge: 20,
        tree_attempts: 8,
        frozen_districts: Vec::new(),
    };
    let mut traced = Chain::new(
        graph.clone(),
        populations.clone(),
        params.clone(),
        Some(initial.clone()),
    )
    .expect("fixture is valid");
    let mut ordinary =
        Chain::new(graph, populations, params, Some(initial.clone())).expect("fixture is valid");

    let batch = traced.step_traced(200);
    let ordinary_status = ordinary.step(200);
    let mut reconstructed = initial;
    for proposal in &batch.proposals {
        let start = proposal.change_start as usize;
        let end = start + proposal.change_count as usize;
        if proposal.outcome != ProposalOutcome::Accepted {
            assert_eq!(proposal.change_count, 0);
        }
        for index in start..end {
            reconstructed[batch.changed_nodes[index] as usize] = batch.changed_districts[index];
        }
    }

    assert_eq!(batch.proposals.len(), 200);
    assert_eq!(batch.status, ordinary_status);
    assert_eq!(reconstructed, traced.assignment());
    assert_eq!(traced.assignment(), ordinary.assignment());
}
