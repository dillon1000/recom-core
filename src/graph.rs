//! Validates the directed CSR input and derives the undirected edge and county-region indexes used
//! by proposals and incremental partition updates. Inputs are offsets, neighbors, and one county-
//! crossing flag per directed edge; outputs are immutable graph indexes safe to share across steps.

use std::collections::{BTreeMap, HashSet, VecDeque};

use crate::RecomError;

/// One canonical undirected graph edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    pub a: u32,
    pub b: u32,
    pub county_cross: bool,
}

/// A connected, symmetric adjacency graph plus indexes derived from its CSR representation.
#[derive(Debug, Clone)]
pub struct CsrGraph {
    offsets: Vec<u32>,
    neighbors: Vec<u32>,
    directed_county_cross: Vec<u8>,
    edges: Vec<Edge>,
    incident_edges: Vec<Vec<u32>>,
    county_regions: Vec<Vec<u32>>,
}

impl CsrGraph {
    /// Validates CSR bounds, edge symmetry, flag consistency, duplicate edges, and whole-graph
    /// connectivity. A rejected graph never reaches chain construction.
    pub fn new(
        offsets: Vec<u32>,
        neighbors: Vec<u32>,
        edge_county_cross: Vec<u8>,
    ) -> Result<Self, RecomError> {
        if offsets.len() < 2 {
            return Err(RecomError::new("graph must contain at least one node"));
        }
        if offsets[0] != 0 {
            return Err(RecomError::new("CSR offsets must start at zero"));
        }
        if neighbors.len() != edge_county_cross.len() {
            return Err(RecomError::new(
                "edge_county_cross must align one-for-one with neighbors",
            ));
        }
        if offsets.windows(2).any(|pair| pair[0] > pair[1]) {
            return Err(RecomError::new("CSR offsets must be monotonic"));
        }
        if offsets.last().copied().map(|value| value as usize) != Some(neighbors.len()) {
            return Err(RecomError::new(
                "final CSR offset must equal the neighbors length",
            ));
        }
        if edge_county_cross.iter().any(|flag| *flag > 1) {
            return Err(RecomError::new(
                "edge_county_cross values must be either zero or one",
            ));
        }

        let node_count = offsets.len() - 1;
        let mut directed_seen = HashSet::with_capacity(neighbors.len());
        let mut edge_parts = BTreeMap::<(u32, u32), (bool, u8)>::new();

        for source in 0..node_count {
            let start = offsets[source] as usize;
            let end = offsets[source + 1] as usize;
            if end > neighbors.len() {
                return Err(RecomError::new("CSR offset exceeds neighbors length"));
            }
            for directed_index in start..end {
                let target = neighbors[directed_index] as usize;
                if target >= node_count {
                    return Err(RecomError::new("neighbor index exceeds graph node count"));
                }
                if target == source {
                    return Err(RecomError::new("self edges are not supported"));
                }
                if !directed_seen.insert((source as u32, target as u32)) {
                    return Err(RecomError::new("duplicate directed edge in CSR graph"));
                }

                let key = if source < target {
                    (source as u32, target as u32)
                } else {
                    (target as u32, source as u32)
                };
                let direction = if source < target { 1 } else { 2 };
                let county_cross = edge_county_cross[directed_index] == 1;
                match edge_parts.get_mut(&key) {
                    Some((existing_flag, directions)) => {
                        if *existing_flag != county_cross {
                            return Err(RecomError::new(
                                "reverse directed edges must share the same county flag",
                            ));
                        }
                        *directions |= direction;
                    }
                    None => {
                        edge_parts.insert(key, (county_cross, direction));
                    }
                }
            }
        }

        if edge_parts.values().any(|(_, directions)| *directions != 3) {
            return Err(RecomError::new(
                "CSR adjacency must contain both directions of every edge",
            ));
        }

        let edges = edge_parts
            .into_iter()
            .map(|((a, b), (county_cross, _))| Edge { a, b, county_cross })
            .collect::<Vec<_>>();
        let mut incident_edges = vec![Vec::new(); node_count];
        for (edge_index, edge) in edges.iter().enumerate() {
            incident_edges[edge.a as usize].push(edge_index as u32);
            incident_edges[edge.b as usize].push(edge_index as u32);
        }

        let graph = Self {
            offsets,
            neighbors,
            directed_county_cross: edge_county_cross,
            edges,
            incident_edges,
            county_regions: Vec::new(),
        };
        if !graph.is_connected() {
            return Err(RecomError::new("graph must be connected"));
        }

        let county_regions = graph.build_county_regions();
        Ok(Self {
            county_regions,
            ..graph
        })
    }

    pub fn node_count(&self) -> usize {
        self.offsets.len() - 1
    }

    pub fn neighbors_of(&self, node: usize) -> &[u32] {
        let start = self.offsets[node] as usize;
        let end = self.offsets[node + 1] as usize;
        &self.neighbors[start..end]
    }

    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    pub fn incident_edges(&self, node: usize) -> &[u32] {
        &self.incident_edges[node]
    }

    pub(crate) fn county_regions(&self) -> &[Vec<u32>] {
        &self.county_regions
    }

    pub fn offsets(&self) -> &[u32] {
        &self.offsets
    }

    pub fn neighbors(&self) -> &[u32] {
        &self.neighbors
    }

    pub fn directed_county_cross(&self) -> &[u8] {
        &self.directed_county_cross
    }

    fn is_connected(&self) -> bool {
        let mut seen = vec![false; self.node_count()];
        let mut queue = VecDeque::from([0_usize]);
        seen[0] = true;
        while let Some(node) = queue.pop_front() {
            for &neighbor in self.neighbors_of(node) {
                let neighbor = neighbor as usize;
                if !seen[neighbor] {
                    seen[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        seen.into_iter().all(|value| value)
    }

    fn build_county_regions(&self) -> Vec<Vec<u32>> {
        let mut seen = vec![false; self.node_count()];
        let mut regions = Vec::new();
        for start in 0..self.node_count() {
            if seen[start] {
                continue;
            }
            let mut region = Vec::new();
            let mut stack = vec![start as u32];
            seen[start] = true;
            while let Some(node) = stack.pop() {
                region.push(node);
                for &edge_index in self.incident_edges(node as usize) {
                    let edge = self.edges[edge_index as usize];
                    if edge.county_cross {
                        continue;
                    }
                    let neighbor = if edge.a == node { edge.b } else { edge.a };
                    if !seen[neighbor as usize] {
                        seen[neighbor as usize] = true;
                        stack.push(neighbor);
                    }
                }
            }
            region.sort_unstable();
            regions.push(region);
        }
        regions
    }
}
