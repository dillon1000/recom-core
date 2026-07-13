//! Property-tests ReCom proposals and burst restarts on grid and planar-like triangulated graphs.
//! Every trace event is checked independently for dense valid labels, nonempty contiguous
//! districts, population balance, and agreement between incremental and full scoring.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;
use recom_core::{
    Chain, ChainParams, CsrGraph, Partition, PopulationBounds, ProposalOutcome, RecomVariant,
};

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
        run_invariant_case(width, rows_per_district, districts, seed, false, 0);
    }

    #[test]
    fn accepted_steps_preserve_planar_like_invariants(
        width in 3_usize..7,
        rows_per_district in 2_usize..5,
        districts in 2_u16..5,
        seed in any::<u64>(),
    ) {
        run_invariant_case(width, rows_per_district, districts, seed, true, 0);
    }

    #[test]
    fn reversible_steps_preserve_grid_invariants(
        width in 3_usize..6,
        rows_per_district in 2_usize..4,
        districts in 2_u16..5,
        seed in any::<u64>(),
        add_diagonals in any::<bool>(),
    ) {
        run_reversible_invariant_case(
            width,
            rows_per_district,
            districts,
            seed,
            add_diagonals,
        );
    }

    #[test]
    fn short_bursts_preserve_invariants_after_every_event(
        width in 3_usize..7,
        rows_per_district in 2_usize..5,
        districts in 2_u16..5,
        seed in any::<u64>(),
        add_diagonals in any::<bool>(),
        burst_length in 5_u32..20,
    ) {
        run_invariant_case(
            width,
            rows_per_district,
            districts,
            seed,
            add_diagonals,
            burst_length,
        );
    }

    #[test]
    fn accepted_steps_minimize_relabeling(
        width in 3_usize..7,
        rows_per_district in 2_usize..5,
        districts in 2_u16..5,
        seed in any::<u64>(),
        add_diagonals in any::<bool>(),
    ) {
        run_minimal_relabeling_case(
            width,
            rows_per_district,
            districts,
            seed,
            add_diagonals,
        );
    }
}

fn run_reversible_invariant_case(
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
    let bounds = PopulationBounds::new(
        populations
            .iter()
            .map(|population| u64::from(*population))
            .sum(),
        districts,
        tolerance,
    )
    .expect("bounds are valid");
    let mut chain = Chain::new(
        graph.clone(),
        populations.clone(),
        ChainParams {
            districts,
            seed,
            pop_tolerance: tolerance,
            county_surcharge: 0,
            tree_attempts: 1,
            burst_length: 0,
            frozen_districts: Vec::new(),
            variant: RecomVariant::Reversible,
            balance_ub: 40,
        },
        Some(initial.clone()),
    )
    .expect("balanced stripe partition is valid");
    let mut replayed = initial;
    for _ in 0..240 {
        let batch = chain.step_traced(1);
        let event = batch.proposals[0];
        let start = event.change_start as usize;
        let end = start + event.change_count as usize;
        if event.outcome != ProposalOutcome::Accepted {
            assert_eq!(event.change_count, 0);
        }
        for index in start..end {
            replayed[batch.changed_nodes[index] as usize] = batch.changed_districts[index];
        }
        assert_partition_invariants(&graph, &populations, &replayed, districts, tolerance);
        let score = Partition::new(&graph, &populations, replayed.clone(), districts, bounds)
            .expect("replayed event remains valid")
            .score();
        assert_eq!(event.score, score);
        assert_eq!(batch.status.current_score, chain.full_recompute_score());
        assert_eq!(replayed, chain.assignment());
    }
}

fn run_minimal_relabeling_case(
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
    let mut chain = Chain::new(
        graph,
        populations,
        ChainParams {
            districts,
            seed,
            pop_tolerance: 0.25,
            county_surcharge: 10,
            tree_attempts: 8,
            burst_length: 0,
            frozen_districts: Vec::new(),
            variant: Default::default(),
            balance_ub: 0,
        },
        Some(initial.clone()),
    )
    .expect("balanced stripe partition is valid");
    let mut replayed = initial;
    for _ in 0..60 {
        let batch = chain.step_traced(1);
        for event in batch.proposals {
            let start = event.change_start as usize;
            let end = start + event.change_count as usize;
            let mut involved_districts = BTreeSet::new();
            for index in start..end {
                let node = batch.changed_nodes[index] as usize;
                involved_districts.insert(replayed[node]);
                involved_districts.insert(batch.changed_districts[index]);
                replayed[node] = batch.changed_districts[index];
            }
            if event.outcome == ProposalOutcome::Accepted && event.change_count > 0 {
                assert_eq!(involved_districts.len(), 2);
                let merged_size = replayed
                    .iter()
                    .filter(|district| involved_districts.contains(district))
                    .count();
                assert!(2 * event.change_count as usize <= merged_size);
            }
        }
        assert_eq!(replayed, chain.assignment());
    }
}

fn run_invariant_case(
    width: usize,
    rows_per_district: usize,
    districts: u16,
    seed: u64,
    add_diagonals: bool,
    burst_length: u32,
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
            burst_length,
            frozen_districts: Vec::new(),
            variant: Default::default(),
            balance_ub: 0,
        },
        Some(initial.clone()),
    )
    .expect("balanced stripe partition is valid");
    let bounds = PopulationBounds::new(
        populations
            .iter()
            .map(|population| u64::from(*population))
            .sum(),
        districts,
        tolerance,
    )
    .expect("bounds are valid");
    let mut replayed = initial;
    for _ in 0..60 {
        let batch = chain.step_traced(1);
        for event in batch.proposals {
            let start = event.change_start as usize;
            let end = start + event.change_count as usize;
            for index in start..end {
                replayed[batch.changed_nodes[index] as usize] = batch.changed_districts[index];
            }
            assert_partition_invariants(&graph, &populations, &replayed, districts, tolerance);
            let score = Partition::new(&graph, &populations, replayed.clone(), districts, bounds)
                .expect("replayed event remains valid")
                .score();
            assert_eq!(event.score, score);
        }
        assert_eq!(batch.status.current_score, chain.full_recompute_score());
        assert_eq!(replayed, chain.assignment());
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
            burst_length: 0,
            frozen_districts: Vec::new(),
            variant: Default::default(),
            balance_ub: 0,
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
                burst_length: 0,
                frozen_districts: Vec::new(),
                variant: Default::default(),
                balance_ub: 0,
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
            burst_length: 0,
            frozen_districts: Vec::new(),
            variant: Default::default(),
            balance_ub: 0,
        },
        Some(row_stripes(4, 4, 2)),
    );
    assert!(result.is_err());
}

#[test]
fn reversible_parameter_combinations_are_validated() {
    let graph = grid_graph(4, 4, false);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(4, 4, 2);
    let base = ChainParams {
        districts: 2,
        seed: 42,
        pop_tolerance: 0.25,
        county_surcharge: 0,
        tree_attempts: 1,
        burst_length: 0,
        frozen_districts: Vec::new(),
        variant: RecomVariant::Reversible,
        balance_ub: 40,
    };
    let error = |params: ChainParams| {
        Chain::new(
            graph.clone(),
            populations.clone(),
            params,
            Some(initial.clone()),
        )
        .expect_err("parameter combination must be rejected")
        .to_string()
    };

    assert!(error(ChainParams {
        county_surcharge: 1,
        ..base.clone()
    })
    .contains("county preservation"));
    assert!(error(ChainParams {
        burst_length: 1,
        ..base.clone()
    })
    .contains("burst restarts"));
    assert!(error(ChainParams {
        frozen_districts: vec![0],
        ..base.clone()
    })
    .contains("frozen districts"));
    assert!(error(ChainParams {
        balance_ub: 0,
        ..base.clone()
    })
    .contains("greater than zero"));
    assert!(error(ChainParams {
        variant: RecomVariant::CutEdgesRmst,
        balance_ub: 40,
        ..base
    })
    .contains("only valid"));
}

#[test]
fn reversible_traced_and_untraced_runs_match() {
    let graph = grid_graph(6, 12, true);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(6, 12, 4);
    let params = ChainParams {
        districts: 4,
        seed: 0x5eed_2026,
        pop_tolerance: 0.25,
        county_surcharge: 0,
        tree_attempts: 1,
        burst_length: 0,
        frozen_districts: Vec::new(),
        variant: RecomVariant::Reversible,
        balance_ub: 40,
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

    let batch = traced.step_traced(2_000);
    let ordinary_status = ordinary.step(2_000);
    let mut replayed = initial;
    let mut outcomes = Vec::new();
    for event in &batch.proposals {
        outcomes.push(event.outcome);
        let start = event.change_start as usize;
        let end = start + event.change_count as usize;
        if event.outcome != ProposalOutcome::Accepted {
            assert_eq!(event.change_count, 0);
        }
        for index in start..end {
            replayed[batch.changed_nodes[index] as usize] = batch.changed_districts[index];
        }
    }

    assert!(outcomes.contains(&ProposalOutcome::NonAdjacentPair));
    assert!(outcomes.contains(&ProposalOutcome::SeamRejected));
    assert!(outcomes.contains(&ProposalOutcome::Accepted));
    assert_eq!(batch.status, ordinary_status);
    assert_eq!(replayed, traced.assignment());
    assert_eq!(traced.assignment(), ordinary.assignment());
}

#[test]
fn reversible_samples_the_small_graph_tree_distribution() {
    let graph = grid_graph(3, 2, true);
    let populations = vec![1_u32; graph.node_count()];
    let bounds = PopulationBounds::new(6, 2, 0.01).expect("bounds are valid");
    let mut target_weights = BTreeMap::<u64, u64>::new();
    for mask in 0_u64..1 << graph.node_count() {
        if mask.count_ones() != 3 {
            continue;
        }
        let assignment = assignment_from_mask(mask, graph.node_count());
        if Partition::new(&graph, &populations, assignment, 2, bounds).is_ok() {
            let first_edges = internal_edge_count(&graph, mask);
            let second_edges = internal_edge_count(&graph, (!mask) & 0b11_1111);
            let canonical_mask = mask.min((!mask) & 0b11_1111);
            target_weights.insert(
                canonical_mask,
                spanning_tree_count_for_three_nodes(first_edges)
                    * spanning_tree_count_for_three_nodes(second_edges),
            );
        }
    }
    let target_total = target_weights.values().sum::<u64>() as f64;

    let initial = row_stripes(3, 2, 2);
    let mut chain = Chain::new(
        graph.clone(),
        populations,
        ChainParams {
            districts: 2,
            seed: 0x2026_0713,
            pop_tolerance: 0.01,
            county_surcharge: 0,
            tree_attempts: 1,
            burst_length: 0,
            frozen_districts: Vec::new(),
            variant: RecomVariant::Reversible,
            balance_ub: 10,
        },
        Some(initial),
    )
    .expect("fixture is valid");
    chain.step(20_000);
    let mut observed = BTreeMap::<u64, u64>::new();
    let samples = 200_000_u64;
    for _ in 0..samples {
        chain.step(1);
        *observed
            .entry(assignment_mask(chain.assignment()))
            .or_default() += 1;
    }

    let total_variation = target_weights
        .iter()
        .map(|(mask, weight)| {
            let target = *weight as f64 / target_total;
            let actual = *observed.get(mask).unwrap_or(&0) as f64 / samples as f64;
            (target - actual).abs()
        })
        .sum::<f64>()
        / 2.0;
    assert!(
        total_variation < 0.08,
        "tree-distribution total variation was {total_variation}"
    );
}

fn assignment_from_mask(mask: u64, node_count: usize) -> Vec<u16> {
    (0..node_count)
        .map(|node| u16::from(mask & (1 << node) == 0))
        .collect()
}

fn assignment_mask(assignment: &[u16]) -> u64 {
    let mask = assignment
        .iter()
        .enumerate()
        .fold(0, |mask, (node, district)| {
            mask | (u64::from(*district == 0) << node)
        });
    mask.min((!mask) & ((1 << assignment.len()) - 1))
}

fn internal_edge_count(graph: &CsrGraph, mask: u64) -> usize {
    graph
        .edges()
        .iter()
        .filter(|edge| {
            let a = mask & (1 << edge.a) != 0;
            let b = mask & (1 << edge.b) != 0;
            a && b
        })
        .count()
}

fn spanning_tree_count_for_three_nodes(edge_count: usize) -> u64 {
    match edge_count {
        2 => 1,
        3 => 3,
        _ => panic!("connected three-node graph has two or three edges"),
    }
}

#[test]
fn burst_trace_reconstructs_every_state_change() {
    let graph = grid_graph(8, 12, false);
    let populations = vec![1_u32; graph.node_count()];
    let initial = row_stripes(8, 12, 4);
    let params = ChainParams {
        districts: 4,
        seed: 0x51a7_e2026,
        pop_tolerance: 0.25,
        county_surcharge: 20,
        tree_attempts: 8,
        burst_length: 10,
        frozen_districts: Vec::new(),
        variant: Default::default(),
        balance_ub: 0,
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

    let mut proposals = Vec::new();
    let mut changed_nodes = Vec::new();
    let mut changed_districts = Vec::new();
    for _ in 0..200 {
        let best_before = traced.status().best_score;
        let batch = traced.step_traced(1);
        for mut proposal in batch.proposals {
            if proposal.outcome == ProposalOutcome::BurstRestart {
                assert_eq!(proposal.score, best_before);
                assert!(proposal.change_count > 0);
            }
            let old_start = proposal.change_start as usize;
            let old_end = old_start + proposal.change_count as usize;
            proposal.change_start = changed_nodes.len() as u32;
            changed_nodes.extend_from_slice(&batch.changed_nodes[old_start..old_end]);
            changed_districts.extend_from_slice(&batch.changed_districts[old_start..old_end]);
            proposals.push(proposal);
        }
    }
    let ordinary_status = ordinary.step(200);
    let mut reconstructed = initial;
    let mut restart_events = 0;
    for (index, proposal) in proposals.iter().enumerate() {
        assert_eq!(proposal.proposal, index as u32 + 1);
        let start = proposal.change_start as usize;
        let end = start + proposal.change_count as usize;
        if proposal.outcome == ProposalOutcome::BurstRestart {
            restart_events += 1;
        } else if proposal.outcome != ProposalOutcome::Accepted {
            assert_eq!(proposal.change_count, 0);
        }
        for index in start..end {
            reconstructed[changed_nodes[index] as usize] = changed_districts[index];
        }
    }

    assert!(ordinary_status.burst_restarts > 0);
    assert_eq!(restart_events, ordinary_status.burst_restarts);
    assert_eq!(traced.status(), ordinary_status);
    assert_eq!(reconstructed, traced.assignment());
    assert_eq!(traced.assignment(), ordinary.assignment());
}
