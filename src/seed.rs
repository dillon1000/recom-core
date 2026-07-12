//! Creates a legal starting partition when the caller supplies no assignment. Each attempt chooses
//! graph-spread seeds, grows contiguous districts through BFS frontiers in population order, and
//! runs the same articulation-safe finishing rebalance used by the public chain API.

use std::collections::{BTreeSet, VecDeque};

use crate::{
    graph::CsrGraph, partition::PopulationBounds, rebalance::rebalance_partition, rng::ChainRng,
    Partition, RecomError,
};

pub(crate) fn generate_seed_assignment(
    graph: &CsrGraph,
    populations: &[u32],
    districts: u16,
    bounds: PopulationBounds,
    rng: &mut ChainRng,
) -> Result<Vec<u16>, RecomError> {
    if graph.node_count() < districts as usize {
        return Err(RecomError::new(
            "district count cannot exceed graph node count",
        ));
    }
    let attempts = (districts as usize * 8).clamp(16, 96);
    let mut best_deviation = u64::MAX;
    for _ in 0..attempts {
        let assignment = grow_once(graph, populations, districts, rng);
        let mut partition =
            Partition::new_for_rebalance(graph, populations, assignment, districts)?;
        let status =
            rebalance_partition(graph, populations, &mut partition, bounds, &BTreeSet::new());
        best_deviation = best_deviation.min(status.max_deviation_ppm);
        if status.achieved_tolerance {
            return Ok(partition.assignment().to_vec());
        }
    }
    Err(RecomError::new(format!(
        "seed-and-grow could not reach population tolerance; best maximum deviation was {:.6}%",
        best_deviation as f64 / 10_000.0
    )))
}

fn grow_once(
    graph: &CsrGraph,
    populations: &[u32],
    districts: u16,
    rng: &mut ChainRng,
) -> Vec<u16> {
    let seeds = spread_seeds(graph, districts as usize, rng);
    let unassigned = u16::MAX;
    let mut assignment = vec![unassigned; graph.node_count()];
    let mut district_pops = vec![0_u64; districts as usize];
    let mut frontiers = vec![BTreeSet::<u32>::new(); districts as usize];
    for (district, seed) in seeds.iter().enumerate() {
        assignment[*seed as usize] = district as u16;
        district_pops[district] = u64::from(populations[*seed as usize]);
    }
    for (district, seed) in seeds.iter().enumerate() {
        for &neighbor in graph.neighbors_of(*seed as usize) {
            if assignment[neighbor as usize] == unassigned {
                frontiers[district].insert(neighbor);
            }
        }
    }

    let mut remaining = graph.node_count() - seeds.len();
    while remaining > 0 {
        let district = (0..districts as usize)
            .filter(|district| !frontiers[*district].is_empty())
            .min_by_key(|district| (district_pops[*district], *district))
            .expect("connected graph always exposes an unassigned frontier");
        let candidates = frontiers[district].iter().copied().collect::<Vec<_>>();
        let minimum_population = candidates
            .iter()
            .map(|node| populations[*node as usize])
            .min()
            .expect("frontier is nonempty");
        let lightest = candidates
            .into_iter()
            .filter(|node| populations[*node as usize] == minimum_population)
            .collect::<Vec<_>>();
        let node = lightest[rng.index(lightest.len())];
        assignment[node as usize] = district as u16;
        district_pops[district] += u64::from(populations[node as usize]);
        remaining -= 1;
        for frontier in &mut frontiers {
            frontier.remove(&node);
        }
        for &neighbor in graph.neighbors_of(node as usize) {
            if assignment[neighbor as usize] == unassigned {
                frontiers[district].insert(neighbor);
            }
        }
    }
    assignment
}

fn spread_seeds(graph: &CsrGraph, count: usize, rng: &mut ChainRng) -> Vec<u32> {
    let mut seeds = vec![rng.index(graph.node_count()) as u32];
    while seeds.len() < count {
        let mut distance = vec![usize::MAX; graph.node_count()];
        let mut queue = VecDeque::new();
        for seed in &seeds {
            distance[*seed as usize] = 0;
            queue.push_back(*seed as usize);
        }
        while let Some(node) = queue.pop_front() {
            for &neighbor in graph.neighbors_of(node) {
                let neighbor = neighbor as usize;
                if distance[neighbor] == usize::MAX {
                    distance[neighbor] = distance[node] + 1;
                    queue.push_back(neighbor);
                }
            }
        }
        let farthest_distance = distance.iter().copied().max().unwrap_or_default();
        let farthest = distance
            .iter()
            .enumerate()
            .filter_map(|(node, value)| (*value == farthest_distance).then_some(node as u32))
            .collect::<Vec<_>>();
        seeds.push(farthest[rng.index(farthest.len())]);
    }
    seeds
}
