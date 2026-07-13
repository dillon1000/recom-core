//! Scans a proposed spanning tree for edges whose subtree populations place both resulting
//! districts inside the global fixed-point population bounds. One candidate is selected from the
//! chain RNG, minimally relabeled against the current assignment, and returned as explicit
//! node-label changes for incremental application.

use std::collections::HashMap;

use crate::{graph::CsrGraph, partition::PopulationBounds, rng::ChainRng, tree::SpanningTree};

#[derive(Debug, Clone)]
pub(crate) struct CutProposal {
    pub(crate) changes: Vec<(u32, u16)>,
}

#[derive(Debug, Clone)]
pub(crate) struct BalancedCutCandidates {
    adjacency: Vec<Vec<usize>>,
    parent: Vec<usize>,
    candidates: Vec<usize>,
}

impl BalancedCutCandidates {
    pub(crate) fn len(&self) -> usize {
        self.candidates.len()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ReversibleCutProposal {
    pub(crate) changes: Vec<(u32, u16)>,
    pub(crate) n_splits: u64,
    pub(crate) seam_length: u64,
}

pub(crate) fn choose_balanced_cut(
    tree: &SpanningTree,
    populations: &[u32],
    assignment: &[u16],
    bounds: PopulationBounds,
    district_a: u16,
    district_b: u16,
    rng: &mut ChainRng,
) -> Option<CutProposal> {
    let candidates = balanced_cut_candidates(tree, populations, bounds)?;
    let child_root = candidates.candidates[rng.index(candidates.len())];
    let (changes, _) = build_cut(
        tree,
        assignment,
        district_a,
        district_b,
        &candidates,
        child_root,
    );
    Some(CutProposal { changes })
}

pub(crate) fn balanced_cut_candidates(
    tree: &SpanningTree,
    populations: &[u32],
    bounds: PopulationBounds,
) -> Option<BalancedCutCandidates> {
    let mut local_by_node = HashMap::with_capacity(tree.nodes.len());
    for (local, node) in tree.nodes.iter().enumerate() {
        local_by_node.insert(*node, local);
    }
    let mut adjacency = vec![Vec::<usize>::new(); tree.nodes.len()];
    for &(a, b) in &tree.edges {
        let a_local = local_by_node[&a];
        let b_local = local_by_node[&b];
        adjacency[a_local].push(b_local);
        adjacency[b_local].push(a_local);
    }
    for neighbors in &mut adjacency {
        neighbors.sort_unstable();
    }

    let mut parent = vec![usize::MAX; tree.nodes.len()];
    let mut order = Vec::with_capacity(tree.nodes.len());
    let mut stack = vec![0_usize];
    parent[0] = 0;
    while let Some(node) = stack.pop() {
        order.push(node);
        for &neighbor in adjacency[node].iter().rev() {
            if parent[neighbor] == usize::MAX {
                parent[neighbor] = node;
                stack.push(neighbor);
            }
        }
    }
    if order.len() != tree.nodes.len() {
        return None;
    }

    let merged_population = tree
        .nodes
        .iter()
        .map(|node| u64::from(populations[*node as usize]))
        .sum::<u64>();
    let mut subtree_population = tree
        .nodes
        .iter()
        .map(|node| u64::from(populations[*node as usize]))
        .collect::<Vec<_>>();
    for &node in order.iter().rev() {
        if node != 0 {
            subtree_population[parent[node]] += subtree_population[node];
        }
    }
    let candidates = (1..tree.nodes.len())
        .filter(|node| {
            let child_population = subtree_population[*node];
            bounds.contains(child_population)
                && bounds.contains(merged_population - child_population)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }

    Some(BalancedCutCandidates {
        adjacency,
        parent,
        candidates,
    })
}

pub(crate) fn choose_reversible_cut(
    graph: &CsrGraph,
    tree: &SpanningTree,
    assignment: &[u16],
    district_a: u16,
    district_b: u16,
    candidates: &BalancedCutCandidates,
    rng: &mut ChainRng,
) -> ReversibleCutProposal {
    let child_root = candidates.candidates[rng.index(candidates.len())];
    let (changes, child_side) = build_cut(
        tree, assignment, district_a, district_b, candidates, child_root,
    );
    ReversibleCutProposal {
        changes,
        n_splits: candidates.len() as u64,
        seam_length: seam_length(graph, tree, &child_side),
    }
}

fn build_cut(
    tree: &SpanningTree,
    assignment: &[u16],
    district_a: u16,
    district_b: u16,
    candidates: &BalancedCutCandidates,
    child_root: usize,
) -> (Vec<(u32, u16)>, Vec<bool>) {
    let mut child_side = vec![false; tree.nodes.len()];
    let mut child_stack = vec![child_root];
    child_side[child_root] = true;
    while let Some(node) = child_stack.pop() {
        for &neighbor in &candidates.adjacency[node] {
            if neighbor != candidates.parent[node] && !child_side[neighbor] {
                child_side[neighbor] = true;
                child_stack.push(neighbor);
            }
        }
    }
    let mut child_a = 0_usize;
    let mut child_b = 0_usize;
    let mut other_a = 0_usize;
    let mut other_b = 0_usize;
    for (local, node) in tree.nodes.iter().enumerate() {
        match (child_side[local], assignment[*node as usize]) {
            (true, district) if district == district_a => child_a += 1,
            (true, district) if district == district_b => child_b += 1,
            (false, district) if district == district_a => other_a += 1,
            (false, district) if district == district_b => other_b += 1,
            _ => debug_assert!(false, "tree nodes must belong to the merged districts"),
        }
    }
    let child_district = if child_b + other_a <= child_a + other_b {
        district_a
    } else {
        district_b
    };
    let other_district = if child_district == district_a {
        district_b
    } else {
        district_a
    };
    let changes = tree
        .nodes
        .iter()
        .enumerate()
        .map(|(local, node)| {
            (
                *node,
                if child_side[local] {
                    child_district
                } else {
                    other_district
                },
            )
        })
        .collect();
    (changes, child_side)
}

fn seam_length(graph: &CsrGraph, tree: &SpanningTree, child_side: &[bool]) -> u64 {
    let mut side_by_node = vec![None; graph.node_count()];
    for (local, node) in tree.nodes.iter().enumerate() {
        side_by_node[*node as usize] = Some(child_side[local]);
    }
    tree.nodes
        .iter()
        .enumerate()
        .filter(|(local, _)| child_side[*local])
        .map(|(_, node)| {
            graph
                .incident_edges(*node as usize)
                .iter()
                .filter(|edge_index| {
                    let edge = graph.edges()[**edge_index as usize];
                    let neighbor = if edge.a == *node { edge.b } else { edge.a };
                    side_by_node[neighbor as usize] == Some(false)
                })
                .count() as u64
        })
        .sum()
}
