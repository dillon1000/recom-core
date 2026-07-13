//! Draws a spanning tree over the two districts selected for recombination. The standard sampler
//! assigns integer ChaCha keys before deterministic Kruskal selection; the reversible sampler uses
//! Wilson's loop-erased random walks to draw from the uniform spanning-tree distribution.

use crate::{graph::CsrGraph, rng::ChainRng};

#[derive(Debug, Clone)]
pub(crate) struct SpanningTree {
    pub(crate) nodes: Vec<u32>,
    pub(crate) edges: Vec<(u32, u32)>,
}

pub(crate) fn random_spanning_tree(
    graph: &CsrGraph,
    assignment: &[u16],
    district_a: u16,
    district_b: u16,
    rng: &mut ChainRng,
    county_surcharge: u32,
) -> Option<SpanningTree> {
    let nodes = assignment
        .iter()
        .enumerate()
        .filter_map(|(node, district)| {
            (*district == district_a || *district == district_b).then_some(node as u32)
        })
        .collect::<Vec<_>>();
    if nodes.len() < 2 {
        return None;
    }

    let mut local_index = vec![usize::MAX; graph.node_count()];
    for (index, node) in nodes.iter().enumerate() {
        local_index[*node as usize] = index;
    }
    let mut candidates = graph
        .edges()
        .iter()
        .enumerate()
        .filter(|(_, edge)| {
            local_index[edge.a as usize] != usize::MAX && local_index[edge.b as usize] != usize::MAX
        })
        .map(|(edge_index, edge)| {
            (
                rng.edge_key(edge.county_cross, county_surcharge),
                edge_index as u32,
                edge.a,
                edge.b,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_unstable();

    let mut sets = DisjointSet::new(nodes.len());
    let mut tree_edges = Vec::with_capacity(nodes.len() - 1);
    for (_, _, a, b) in candidates {
        let a_index = local_index[a as usize];
        let b_index = local_index[b as usize];
        if sets.union(a_index, b_index) {
            tree_edges.push((a, b));
            if tree_edges.len() + 1 == nodes.len() {
                break;
            }
        }
    }
    (tree_edges.len() + 1 == nodes.len()).then_some(SpanningTree {
        nodes,
        edges: tree_edges,
    })
}

pub(crate) fn uniform_spanning_tree(
    graph: &CsrGraph,
    assignment: &[u16],
    district_a: u16,
    district_b: u16,
    rng: &mut ChainRng,
) -> Option<SpanningTree> {
    let nodes = assignment
        .iter()
        .enumerate()
        .filter_map(|(node, district)| {
            (*district == district_a || *district == district_b).then_some(node as u32)
        })
        .collect::<Vec<_>>();
    if nodes.len() < 2 {
        return None;
    }

    let mut in_region = vec![false; graph.node_count()];
    for &node in &nodes {
        in_region[node as usize] = true;
    }
    let mut region_neighbors = vec![Vec::<u32>::new(); graph.node_count()];
    for &node in &nodes {
        region_neighbors[node as usize].extend(
            graph
                .neighbors_of(node as usize)
                .iter()
                .copied()
                .filter(|neighbor| in_region[*neighbor as usize]),
        );
        if region_neighbors[node as usize].is_empty() {
            return None;
        }
    }

    let root = nodes[0] as usize;
    let mut connected = vec![false; graph.node_count()];
    let mut stack = vec![root];
    connected[root] = true;
    let mut connected_count = 0_usize;
    while let Some(node) = stack.pop() {
        connected_count += 1;
        for &neighbor in &region_neighbors[node] {
            if !connected[neighbor as usize] {
                connected[neighbor as usize] = true;
                stack.push(neighbor as usize);
            }
        }
    }
    if connected_count != nodes.len() {
        return None;
    }

    let walk_step_budget = nodes
        .len()
        .saturating_mul(nodes.len())
        .saturating_mul(1_024)
        .max(4_096);
    let mut walk_steps = 0_usize;
    let mut in_tree = vec![false; graph.node_count()];
    let mut next = vec![u32::MAX; graph.node_count()];
    let mut edges = Vec::with_capacity(nodes.len() - 1);
    in_tree[root] = true;

    for &start in &nodes {
        let mut node = start as usize;
        while !in_tree[node] {
            if walk_steps == walk_step_budget {
                return None;
            }
            walk_steps += 1;
            let neighbors = &region_neighbors[node];
            let neighbor = neighbors[rng.index(neighbors.len())];
            next[node] = neighbor;
            node = neighbor as usize;
        }

        node = start as usize;
        while !in_tree[node] {
            in_tree[node] = true;
            let neighbor = next[node];
            if neighbor == u32::MAX {
                return None;
            }
            edges.push((node as u32, neighbor));
            node = neighbor as usize;
        }
    }

    (edges.len() + 1 == nodes.len()).then_some(SpanningTree { nodes, edges })
}

#[derive(Debug)]
struct DisjointSet {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
            rank: vec![0; size],
        }
    }

    fn find(&mut self, value: usize) -> usize {
        if self.parent[value] != value {
            self.parent[value] = self.find(self.parent[value]);
        }
        self.parent[value]
    }

    fn union(&mut self, a: usize, b: usize) -> bool {
        let root_a = self.find(a);
        let root_b = self.find(b);
        if root_a == root_b {
            return false;
        }
        match self.rank[root_a].cmp(&self.rank[root_b]) {
            std::cmp::Ordering::Less => self.parent[root_a] = root_b,
            std::cmp::Ordering::Greater => self.parent[root_b] = root_a,
            std::cmp::Ordering::Equal => {
                self.parent[root_b] = root_a;
                self.rank[root_a] += 1;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn wilson_sampler_is_uniform_on_a_four_cycle() {
        let graph = four_cycle();
        let assignment = vec![0, 0, 1, 1];
        let mut counts = BTreeMap::<Vec<(u32, u32)>, usize>::new();
        for seed in 0..4_000 {
            let tree = uniform_spanning_tree(&graph, &assignment, 0, 1, &mut ChainRng::new(seed))
                .expect("the cycle is connected");
            let mut edges = tree
                .edges
                .into_iter()
                .map(|(a, b)| if a < b { (a, b) } else { (b, a) })
                .collect::<Vec<_>>();
            edges.sort_unstable();
            *counts.entry(edges).or_default() += 1;
        }

        assert_eq!(counts.len(), 4);
        for count in counts.values() {
            assert!((800..=1_200).contains(count), "tree count was {count}");
        }
    }

    fn four_cycle() -> CsrGraph {
        CsrGraph::new(
            vec![0, 2, 4, 6, 8],
            vec![1, 3, 0, 2, 1, 3, 0, 2],
            vec![0; 8],
            None,
        )
        .expect("cycle graph is valid")
    }
}
