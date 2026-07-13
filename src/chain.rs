//! Orchestrates ReCom proposals and owns all mutable solver state. Each requested step selects an
//! eligible district boundary, redraws up to `tree_attempts` region-aware trees, applies one
//! balanced cut, and updates cumulative acceptance and best-plan status. Optional compact trace
//! batches expose every outcome and accepted assignment delta without cloning complete plans.

use std::collections::BTreeSet;

use recom_scoring::{
    FrontierEntry, ParetoArchive, PlanScore, SelectionWeights, MAX_COUNTY_PRESERVATION,
};
use serde::Serialize;

use crate::{
    cut::choose_balanced_cut,
    graph::CsrGraph,
    partition::{Partition, PopulationBounds},
    rebalance::{rebalance_partition, RebalanceStatus},
    rng::ChainRng,
    seed::generate_seed_assignment,
    tree::random_spanning_tree,
    RecomError,
};

#[derive(Debug, Clone)]
pub struct ChainParams {
    pub districts: u16,
    pub seed: u64,
    pub pop_tolerance: f64,
    pub county_surcharge: u32,
    pub tree_attempts: u32,
    pub burst_length: u32,
    pub frozen_districts: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStatus {
    pub steps_accepted: u32,
    pub steps_rejected: u32,
    pub burst_restarts: u32,
    pub current_score: PlanScore,
    pub best_score: PlanScore,
    pub frontier_size: u32,
}

/// Why one trace event did or did not advance the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalOutcome {
    Accepted,
    BurstRestart,
    NoEligibleBoundary,
    NoSpanningTree,
    NoBalancedCut,
}

/// Metadata for one proposal or burst restart. State changes occupy the declared range in the
/// owning [`TraceBatch`]; rejected attempts have an empty range and retain the preceding score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalTrace {
    pub proposal: u32,
    pub outcome: ProposalOutcome,
    pub score: PlanScore,
    pub change_start: u32,
    pub change_count: u32,
    pub frontier_changed: bool,
}

/// Compact changes and per-proposal metadata returned by [`Chain::step_traced`]. Node indexes and
/// district labels align one-for-one; native labels are zero-based and the WASM wrapper converts
/// districts to the browser's one-based contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBatch {
    pub status: ChainStatus,
    pub proposals: Vec<ProposalTrace>,
    pub changed_nodes: Vec<u32>,
    pub changed_districts: Vec<u16>,
}

#[derive(Debug)]
struct StepTrace {
    outcome: ProposalOutcome,
    changes: Vec<(u32, u16)>,
    frontier_changed: bool,
}

#[derive(Debug, Clone)]
pub struct Chain {
    graph: CsrGraph,
    populations: Vec<u32>,
    partition: Partition,
    bounds: PopulationBounds,
    rng: ChainRng,
    county_surcharge: u32,
    selection_weights: SelectionWeights,
    tree_attempts: u32,
    burst_length: u32,
    steps_since_restart: u32,
    burst_restarts: u32,
    frozen_districts: BTreeSet<u16>,
    steps_accepted: u32,
    steps_rejected: u32,
    current_score: PlanScore,
    frontier: ParetoArchive,
}

impl Chain {
    pub fn new(
        graph: CsrGraph,
        populations: Vec<u32>,
        params: ChainParams,
        initial_assignment: Option<Vec<u16>>,
    ) -> Result<Self, RecomError> {
        if populations.len() != graph.node_count() {
            return Err(RecomError::new(
                "population array must match graph node count",
            ));
        }
        if params.districts < 2 {
            return Err(RecomError::new("district count must be at least two"));
        }
        if params.tree_attempts == 0 {
            return Err(RecomError::new("tree_attempts must be greater than zero"));
        }
        if params.county_surcharge > MAX_COUNTY_PRESERVATION {
            return Err(RecomError::new(
                "county preservation must be an integer between 0 and 50",
            ));
        }
        if params
            .frozen_districts
            .iter()
            .any(|district| *district >= params.districts)
        {
            return Err(RecomError::new(
                "frozen district contains an out-of-range district",
            ));
        }
        let total_population = populations.iter().map(|value| u64::from(*value)).sum();
        let bounds =
            PopulationBounds::new(total_population, params.districts, params.pop_tolerance)?;
        let mut rng = ChainRng::new(params.seed);
        let assignment = match initial_assignment {
            Some(assignment) => assignment,
            None => {
                generate_seed_assignment(&graph, &populations, params.districts, bounds, &mut rng)?
            }
        };
        let partition = Partition::new(&graph, &populations, assignment, params.districts, bounds)?;
        let current_score = partition.score();
        debug_assert_eq!(current_score, partition.full_recompute_score(&graph));
        let mut frontier = ParetoArchive::default();
        frontier.insert(current_score, partition.assignment().to_vec());
        Ok(Self {
            graph,
            populations,
            partition,
            bounds,
            rng,
            county_surcharge: params.county_surcharge,
            selection_weights: SelectionWeights::for_county_preservation(params.county_surcharge),
            tree_attempts: params.tree_attempts,
            burst_length: params.burst_length,
            steps_since_restart: 0,
            burst_restarts: 0,
            frozen_districts: params.frozen_districts.into_iter().collect(),
            steps_accepted: 0,
            steps_rejected: 0,
            current_score,
            frontier,
        })
    }

    pub fn step(&mut self, count: u32) -> ChainStatus {
        for _ in 0..count {
            let _ = self.maybe_restart();
            self.step_once();
        }
        self.status()
    }

    /// Advances the chain while retaining compact deltas for every accepted proposal and burst
    /// restart plus explicit reasons for every rejection. The ordinary [`Chain::step`] path remains
    /// allocation-light between burst boundaries.
    pub fn step_traced(&mut self, count: u32) -> TraceBatch {
        let mut proposals = Vec::with_capacity(count as usize);
        let mut changed_nodes = Vec::new();
        let mut changed_districts = Vec::new();
        for _ in 0..count {
            if let Some(changes) = self.maybe_restart() {
                let change_start = changed_nodes.len() as u32;
                for (node, district) in &changes {
                    changed_nodes.push(*node);
                    changed_districts.push(*district);
                }
                proposals.push(ProposalTrace {
                    proposal: self.steps_accepted + self.steps_rejected + self.burst_restarts,
                    outcome: ProposalOutcome::BurstRestart,
                    score: self.current_score,
                    change_start,
                    change_count: changes.len() as u32,
                    frontier_changed: false,
                });
            }
            let trace = self.step_once();
            let change_start = changed_nodes.len() as u32;
            for (node, district) in &trace.changes {
                changed_nodes.push(*node);
                changed_districts.push(*district);
            }
            proposals.push(ProposalTrace {
                proposal: self.steps_accepted + self.steps_rejected + self.burst_restarts,
                outcome: trace.outcome,
                score: self.current_score,
                change_start,
                change_count: trace.changes.len() as u32,
                frontier_changed: trace.frontier_changed,
            });
        }
        TraceBatch {
            status: self.status(),
            proposals,
            changed_nodes,
            changed_districts,
        }
    }

    pub fn rebalance(&mut self, tolerance: f64) -> Result<RebalanceStatus, RecomError> {
        let bounds = PopulationBounds::new(
            self.bounds.total_population(),
            self.bounds.districts(),
            tolerance,
        )?;
        let status = rebalance_partition(
            &self.graph,
            &self.populations,
            &mut self.partition,
            bounds,
            &self.frozen_districts,
        );
        self.update_scores();
        Ok(status)
    }

    pub fn assignment(&self) -> &[u16] {
        self.partition.assignment()
    }

    pub fn best_assignment(&self) -> &[u16] {
        &self
            .frontier
            .best_with_weights(self.selection_weights)
            .expect("every chain frontier contains its initial assignment")
            .assignment
    }

    pub fn frontier(&self) -> &[FrontierEntry] {
        self.frontier.entries()
    }

    pub fn district_populations(&self) -> &[u64] {
        self.partition.district_populations()
    }

    pub fn cut_edge_count(&self) -> u32 {
        self.partition.cut_edges().len() as u32
    }

    /// Independently recomputes the current score for debug and integration-test self-checks.
    #[doc(hidden)]
    pub fn full_recompute_score(&self) -> PlanScore {
        self.partition.full_recompute_score(&self.graph)
    }

    pub fn status(&self) -> ChainStatus {
        ChainStatus {
            steps_accepted: self.steps_accepted,
            steps_rejected: self.steps_rejected,
            burst_restarts: self.burst_restarts,
            current_score: self.current_score,
            best_score: self
                .frontier
                .best_with_weights(self.selection_weights)
                .expect("every chain frontier contains its initial assignment")
                .score,
            frontier_size: self.frontier.entries().len() as u32,
        }
    }

    fn step_once(&mut self) -> StepTrace {
        self.steps_since_restart = self.steps_since_restart.saturating_add(1);
        let eligible_edges = self
            .partition
            .cut_edges()
            .iter()
            .copied()
            .filter(|edge_index| {
                let edge = self.graph.edges()[*edge_index as usize];
                let district_a = self.partition.assignment()[edge.a as usize];
                let district_b = self.partition.assignment()[edge.b as usize];
                !self.frozen_districts.contains(&district_a)
                    && !self.frozen_districts.contains(&district_b)
            })
            .collect::<Vec<_>>();
        if eligible_edges.is_empty() {
            self.steps_rejected += 1;
            return StepTrace {
                outcome: ProposalOutcome::NoEligibleBoundary,
                changes: Vec::new(),
                frontier_changed: false,
            };
        }
        let boundary_edge =
            self.graph.edges()[eligible_edges[self.rng.index(eligible_edges.len())] as usize];
        let district_a = self.partition.assignment()[boundary_edge.a as usize];
        let district_b = self.partition.assignment()[boundary_edge.b as usize];

        let mut built_tree = false;
        for _ in 0..self.tree_attempts {
            let Some(tree) = random_spanning_tree(
                &self.graph,
                self.partition.assignment(),
                district_a,
                district_b,
                &mut self.rng,
                self.county_surcharge,
            ) else {
                continue;
            };
            built_tree = true;
            let Some(proposal) = choose_balanced_cut(
                &tree,
                &self.populations,
                self.partition.assignment(),
                self.bounds,
                district_a,
                district_b,
                &mut self.rng,
            ) else {
                continue;
            };
            let changes = proposal
                .changes
                .into_iter()
                .filter(|(node, district)| self.partition.assignment()[*node as usize] != *district)
                .collect::<Vec<_>>();
            self.partition
                .apply_assignment_changes(&self.graph, &self.populations, &changes);
            self.steps_accepted += 1;
            let frontier_changed = self.update_scores();
            return StepTrace {
                outcome: ProposalOutcome::Accepted,
                changes,
                frontier_changed,
            };
        }
        self.steps_rejected += 1;
        StepTrace {
            outcome: if built_tree {
                ProposalOutcome::NoBalancedCut
            } else {
                ProposalOutcome::NoSpanningTree
            },
            changes: Vec::new(),
            frontier_changed: false,
        }
    }

    fn maybe_restart(&mut self) -> Option<Vec<(u32, u16)>> {
        if self.burst_length == 0 || self.steps_since_restart < self.burst_length {
            return None;
        }
        self.steps_since_restart = 0;
        let target = self
            .frontier
            .best_with_weights(self.selection_weights)
            .expect("every chain frontier contains its initial assignment");
        let changes = self
            .partition
            .assignment()
            .iter()
            .zip(&target.assignment)
            .enumerate()
            .filter_map(|(node, (current, next))| (current != next).then_some((node as u32, *next)))
            .collect::<Vec<_>>();
        if changes.is_empty() {
            return None;
        }
        self.partition
            .apply_assignment_changes(&self.graph, &self.populations, &changes);
        self.update_scores();
        self.burst_restarts += 1;
        Some(changes)
    }

    fn update_scores(&mut self) -> bool {
        self.current_score = self.partition.score();
        debug_assert_eq!(
            self.current_score,
            self.partition.full_recompute_score(&self.graph)
        );
        self.frontier
            .insert(self.current_score, self.partition.assignment().to_vec())
    }
}
