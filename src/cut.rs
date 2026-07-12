//! Scans a proposed spanning tree for edges whose subtree populations place both resulting
//! districts inside the global fixed-point population bounds. One candidate is selected from the
//! chain RNG and returned as explicit node-label changes for incremental application.

use std::collections::HashMap;

use crate::{partition::PopulationBounds, rng::ChainRng, tree::SpanningTree};

#[derive(Debug, Clone)]
pub(crate) struct CutProposal {
    pub(crate) changes: Vec<(u32, u16)>,
}

pub(crate) fn choose_balanced_cut(
    tree: &SpanningTree,
    populations: &[u32],
    bounds: PopulationBounds,
    district_a: u16,
    district_b: u16,
    rng: &mut ChainRng,
) -> Option<CutProposal> {
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
    let child_root = candidates[rng.index(candidates.len())];

    let mut child_side = vec![false; tree.nodes.len()];
    let mut child_stack = vec![child_root];
    child_side[child_root] = true;
    while let Some(node) = child_stack.pop() {
        for &neighbor in &adjacency[node] {
            if neighbor != parent[node] && !child_side[neighbor] {
                child_side[neighbor] = true;
                child_stack.push(neighbor);
            }
        }
    }
    let child_district = if rng.coin() { district_a } else { district_b };
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
    Some(CutProposal { changes })
}
