//! Computes plan compactness and county-integrity summaries from immutable graph regions and the
//! current partition. The score is used for progress reporting and deterministic best-plan
//! tracking; changing its weighting does not alter validity constraints.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::{graph::CsrGraph, partition::Partition};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanScore {
    pub cut_edges: u32,
    pub county_splits: u32,
}

impl PlanScore {
    pub(crate) fn calculate(graph: &CsrGraph, partition: &Partition) -> Self {
        let county_splits = graph
            .county_regions()
            .iter()
            .filter(|region| {
                let districts = region
                    .iter()
                    .map(|node| partition.assignment()[*node as usize])
                    .collect::<BTreeSet<_>>();
                districts.len() > 1
            })
            .count() as u32;
        Self {
            cut_edges: partition.cut_edges().len() as u32,
            county_splits,
        }
    }

    pub(crate) fn is_better_than(self, other: Self, county_weight: u64) -> bool {
        let self_weighted =
            u128::from(self.cut_edges) + u128::from(self.county_splits) * u128::from(county_weight);
        let other_weighted = u128::from(other.cut_edges)
            + u128::from(other.county_splits) * u128::from(county_weight);
        (self_weighted, self.cut_edges, self.county_splits)
            < (other_weighted, other.cut_edges, other.county_splits)
    }
}
