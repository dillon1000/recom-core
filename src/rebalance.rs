//! Tightens population deviation through deterministic border-unit flips. A move is eligible only
//! when it strictly improves maximum deviation, attaches to the receiving district, leaves the
//! donor connected under an articulation check, and does not touch a frozen district.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::{graph::CsrGraph, partition::PopulationBounds, Partition};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalanceStatus {
    pub moves: u32,
    pub achieved_tolerance: bool,
    pub max_deviation_ppm: u64,
}

pub(crate) fn rebalance_partition(
    graph: &CsrGraph,
    populations: &[u32],
    partition: &mut Partition,
    bounds: PopulationBounds,
    frozen_districts: &BTreeSet<u16>,
) -> RebalanceStatus {
    let mut moves = 0_u32;
    let max_moves = graph
        .node_count()
        .saturating_mul(bounds.districts() as usize)
        * 4;
    while (moves as usize) < max_moves {
        let current_max = partition
            .district_populations()
            .iter()
            .map(|population| bounds.deviation_numerator(*population))
            .max()
            .unwrap_or_default();
        let mut best: Option<(u128, u32, u16)> = None;

        for (node, &unit_population) in populations.iter().enumerate() {
            let donor = partition.assignment()[node];
            if frozen_districts.contains(&donor) || partition.district_unit_count(donor) <= 1 {
                continue;
            }
            let recipients = graph
                .neighbors_of(node)
                .iter()
                .map(|neighbor| partition.assignment()[*neighbor as usize])
                .filter(|district| *district != donor && !frozen_districts.contains(district))
                .collect::<BTreeSet<_>>();
            if recipients.is_empty()
                || !partition.district_is_connected_without(graph, donor, node as u32)
            {
                continue;
            }
            let node_population = u64::from(unit_population);
            for recipient in recipients {
                let mut proposed_pops = partition.district_populations().to_vec();
                proposed_pops[donor as usize] -= node_population;
                proposed_pops[recipient as usize] += node_population;
                let proposed_max = proposed_pops
                    .iter()
                    .map(|population| bounds.deviation_numerator(*population))
                    .max()
                    .unwrap_or_default();
                if proposed_max >= current_max {
                    continue;
                }
                let candidate = (proposed_max, node as u32, recipient);
                if best.is_none_or(|existing| candidate < existing) {
                    best = Some(candidate);
                }
            }
        }

        let Some((_, node, recipient)) = best else {
            break;
        };
        partition.apply_assignment_changes(graph, populations, &[(node, recipient)]);
        moves += 1;
    }

    let max_deviation_ppm = bounds.max_deviation_ppm(partition.district_populations());
    RebalanceStatus {
        moves,
        achieved_tolerance: partition
            .district_populations()
            .iter()
            .all(|population| bounds.contains(*population)),
        max_deviation_ppm,
    }
}
