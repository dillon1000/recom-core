//! Stores the dense zero-based district assignment, population totals, and canonical cut-edge set.
//! Construction validates labels, nonempty contiguous districts, and population bounds. Proposal
//! application updates only changed nodes and incident cut edges, keeping step cost local.

use std::collections::{BTreeSet, VecDeque};

use crate::{graph::CsrGraph, RecomError};

const PPM_SCALE: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PopulationBounds {
    total_population: u64,
    districts: u16,
    tolerance_ppm: u64,
}

impl PopulationBounds {
    pub fn new(total_population: u64, districts: u16, tolerance: f64) -> Result<Self, RecomError> {
        if total_population == 0 {
            return Err(RecomError::new(
                "total population must be greater than zero",
            ));
        }
        if districts < 2 {
            return Err(RecomError::new("district count must be at least two"));
        }
        if !tolerance.is_finite() || !(0.0..1.0).contains(&tolerance) {
            return Err(RecomError::new(
                "population tolerance must be finite and in [0, 1)",
            ));
        }
        let tolerance_ppm = (tolerance * PPM_SCALE as f64).round() as u64;
        Ok(Self {
            total_population,
            districts,
            tolerance_ppm,
        })
    }

    pub fn contains(&self, population: u64) -> bool {
        let scaled_population =
            u128::from(population) * u128::from(self.districts) * u128::from(PPM_SCALE);
        let total = u128::from(self.total_population);
        let lower = total * u128::from(PPM_SCALE - self.tolerance_ppm);
        let upper = total * u128::from(PPM_SCALE + self.tolerance_ppm);
        (lower..=upper).contains(&scaled_population)
    }

    pub(crate) fn deviation_numerator(&self, population: u64) -> u128 {
        let district_total = u128::from(population) * u128::from(self.districts);
        district_total.abs_diff(u128::from(self.total_population))
    }

    pub(crate) fn max_deviation_ppm(&self, populations: &[u64]) -> u64 {
        let numerator = populations
            .iter()
            .map(|population| self.deviation_numerator(*population))
            .max()
            .unwrap_or_default()
            * u128::from(PPM_SCALE);
        numerator.div_ceil(u128::from(self.total_population)) as u64
    }

    pub fn total_population(&self) -> u64 {
        self.total_population
    }

    pub fn districts(&self) -> u16 {
        self.districts
    }
}

#[derive(Debug, Clone)]
pub struct Partition {
    assignment: Vec<u16>,
    district_pops: Vec<u64>,
    cut_edges: Vec<u32>,
    cut_edge_positions: Vec<Option<usize>>,
    district_unit_counts: Vec<usize>,
}

impl Partition {
    pub fn new(
        graph: &CsrGraph,
        populations: &[u32],
        assignment: Vec<u16>,
        districts: u16,
        bounds: PopulationBounds,
    ) -> Result<Self, RecomError> {
        Self::build(graph, populations, assignment, districts, Some(bounds))
    }

    pub(crate) fn new_for_rebalance(
        graph: &CsrGraph,
        populations: &[u32],
        assignment: Vec<u16>,
        districts: u16,
    ) -> Result<Self, RecomError> {
        Self::build(graph, populations, assignment, districts, None)
    }

    fn build(
        graph: &CsrGraph,
        populations: &[u32],
        assignment: Vec<u16>,
        districts: u16,
        bounds: Option<PopulationBounds>,
    ) -> Result<Self, RecomError> {
        if populations.len() != graph.node_count() || assignment.len() != graph.node_count() {
            return Err(RecomError::new(
                "population and assignment arrays must match graph node count",
            ));
        }
        if assignment.iter().any(|district| *district >= districts) {
            return Err(RecomError::new(
                "assignment contains an out-of-range district",
            ));
        }

        let mut district_pops = vec![0_u64; districts as usize];
        let mut district_unit_counts = vec![0_usize; districts as usize];
        for (node, district) in assignment.iter().enumerate() {
            district_pops[*district as usize] += u64::from(populations[node]);
            district_unit_counts[*district as usize] += 1;
        }
        if district_unit_counts.contains(&0) {
            return Err(RecomError::new(
                "every district must contain at least one unit",
            ));
        }
        if bounds.is_some_and(|bounds| {
            district_pops
                .iter()
                .any(|population| !bounds.contains(*population))
        }) {
            return Err(RecomError::new(
                "initial assignment exceeds the configured population tolerance",
            ));
        }
        validate_contiguity(graph, &assignment, districts)?;

        let mut partition = Self {
            assignment,
            district_pops,
            cut_edges: Vec::new(),
            cut_edge_positions: vec![None; graph.edges().len()],
            district_unit_counts,
        };
        for edge_index in 0..graph.edges().len() {
            partition.refresh_cut_edge(graph, edge_index as u32);
        }
        Ok(partition)
    }

    pub fn assignment(&self) -> &[u16] {
        &self.assignment
    }

    pub fn district_populations(&self) -> &[u64] {
        &self.district_pops
    }

    pub fn cut_edges(&self) -> &[u32] {
        &self.cut_edges
    }

    pub(crate) fn district_unit_count(&self, district: u16) -> usize {
        self.district_unit_counts[district as usize]
    }

    pub(crate) fn apply_assignment_changes(
        &mut self,
        graph: &CsrGraph,
        populations: &[u32],
        changes: &[(u32, u16)],
    ) {
        let mut affected_edges = BTreeSet::new();
        for &(node, new_district) in changes {
            let node_index = node as usize;
            let old_district = self.assignment[node_index];
            if old_district == new_district {
                continue;
            }
            let population = u64::from(populations[node_index]);
            self.district_pops[old_district as usize] -= population;
            self.district_pops[new_district as usize] += population;
            self.district_unit_counts[old_district as usize] -= 1;
            self.district_unit_counts[new_district as usize] += 1;
            self.assignment[node_index] = new_district;
            affected_edges.extend(graph.incident_edges(node_index).iter().copied());
        }
        for edge_index in affected_edges {
            self.refresh_cut_edge(graph, edge_index);
        }
    }

    pub(crate) fn district_is_connected_without(
        &self,
        graph: &CsrGraph,
        district: u16,
        removed_node: u32,
    ) -> bool {
        if self.district_unit_count(district) <= 1 {
            return false;
        }
        let start = self
            .assignment
            .iter()
            .enumerate()
            .find(|(node, value)| **value == district && *node != removed_node as usize)
            .map(|(node, _)| node);
        let Some(start) = start else {
            return false;
        };
        let mut seen = vec![false; graph.node_count()];
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut visited = 0_usize;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            for &neighbor in graph.neighbors_of(node) {
                let neighbor = neighbor as usize;
                if neighbor != removed_node as usize
                    && !seen[neighbor]
                    && self.assignment[neighbor] == district
                {
                    seen[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        visited + 1 == self.district_unit_count(district)
    }

    fn refresh_cut_edge(&mut self, graph: &CsrGraph, edge_index: u32) {
        let edge = graph.edges()[edge_index as usize];
        let should_be_cut = self.assignment[edge.a as usize] != self.assignment[edge.b as usize];
        match (should_be_cut, self.cut_edge_positions[edge_index as usize]) {
            (true, None) => {
                self.cut_edge_positions[edge_index as usize] = Some(self.cut_edges.len());
                self.cut_edges.push(edge_index);
            }
            (false, Some(position)) => {
                let removed = self.cut_edges.swap_remove(position);
                debug_assert_eq!(removed, edge_index);
                self.cut_edge_positions[edge_index as usize] = None;
                if position < self.cut_edges.len() {
                    let moved = self.cut_edges[position];
                    self.cut_edge_positions[moved as usize] = Some(position);
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn validate_contiguity(
    graph: &CsrGraph,
    assignment: &[u16],
    districts: u16,
) -> Result<(), RecomError> {
    for district in 0..districts {
        let Some(start) = assignment.iter().position(|value| *value == district) else {
            return Err(RecomError::new(
                "every district must contain at least one unit",
            ));
        };
        let expected = assignment
            .iter()
            .filter(|value| **value == district)
            .count();
        let mut seen = vec![false; graph.node_count()];
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut visited = 0_usize;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            for &neighbor in graph.neighbors_of(node) {
                let neighbor = neighbor as usize;
                if !seen[neighbor] && assignment[neighbor] == district {
                    seen[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        if visited != expected {
            return Err(RecomError::new("every district must be contiguous"));
        }
    }
    Ok(())
}
