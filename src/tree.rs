//! Draws a random spanning tree over the two districts selected for recombination. Candidate edges
//! receive integer ChaCha keys plus the optional county-crossing surcharge, then deterministic
//! Kruskal selection produces a tree without platform-dependent floating-point weights.

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
    county_surcharge: u64,
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
