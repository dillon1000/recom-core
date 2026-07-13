//! Defines the score contract and maintains its graph-wide components incrementally. Inputs are
//! canonical weighted edges, county-region memberships, assignment changes, and district
//! populations; outputs are exact scores plus a full-recompute oracle for verification.

use std::fmt::{Display, Formatter};

use serde::Serialize;

const PPM_SCALE: u128 = 1_000_000;

/// The three optimization objectives plus the familiar report-only county split count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanScore {
    pub weighted_cut: u64,
    pub county_fragments: u32,
    pub county_splits: u32,
    pub max_deviation_ppm: u64,
}

impl PlanScore {
    /// Returns the ordered objective tuple used for dominance, deterministic sorting, and best-plan
    /// compatibility. `county_splits` is intentionally excluded because it is report-only.
    pub const fn objective_tuple(self) -> (u64, u32, u64) {
        (
            self.weighted_cut,
            self.county_fragments,
            self.max_deviation_ppm,
        )
    }

    /// True when this score is no worse in every objective and strictly better in at least one.
    pub const fn dominates(self, other: Self) -> bool {
        self.weighted_cut <= other.weighted_cut
            && self.county_fragments <= other.county_fragments
            && self.max_deviation_ppm <= other.max_deviation_ppm
            && (self.weighted_cut < other.weighted_cut
                || self.county_fragments < other.county_fragments
                || self.max_deviation_ppm < other.max_deviation_ppm)
    }
}

/// A canonical undirected edge reduced to the fields scoring needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeightedEdge {
    pub a: u32,
    pub b: u32,
    pub weight: u32,
}

/// An optimization metric with deterministic iteration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreMetric {
    WeightedCut,
    CountyFragments,
    MaxDeviationPpm,
}

impl ScoreMetric {
    pub const ALL: [Self; 3] = [
        Self::WeightedCut,
        Self::CountyFragments,
        Self::MaxDeviationPpm,
    ];

    pub const fn value(self, score: PlanScore) -> u64 {
        match self {
            Self::WeightedCut => score.weighted_cut,
            Self::CountyFragments => score.county_fragments as u64,
            Self::MaxDeviationPpm => score.max_deviation_ppm,
        }
    }
}

/// Invalid scoring topology or state supplied by a caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreError(String);

impl ScoreError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ScoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ScoreError {}

/// Mutable graph-wide score state. Edge cut flags and county-region district-presence counts are
/// updated alongside the solver partition, while population deviation remains O(districts).
#[derive(Debug, Clone)]
pub struct IncrementalScore {
    edge_weights: Vec<u32>,
    edge_is_cut: Vec<bool>,
    node_regions: Vec<usize>,
    region_district_counts: Vec<Vec<u32>>,
    district_count: u16,
    total_population: u64,
    weighted_cut: u64,
    county_fragments: u32,
    county_splits: u32,
}

impl IncrementalScore {
    /// Builds and validates the scoring indexes. County regions must cover every node exactly once.
    pub fn new(
        node_count: usize,
        edges: &[WeightedEdge],
        county_regions: &[Vec<u32>],
        assignment: &[u16],
        district_count: u16,
        total_population: u64,
    ) -> Result<Self, ScoreError> {
        validate_inputs(
            node_count,
            edges,
            county_regions,
            assignment,
            district_count,
            total_population,
        )?;

        let mut node_regions = vec![usize::MAX; node_count];
        let mut region_district_counts =
            vec![vec![0_u32; district_count as usize]; county_regions.len()];
        for (region_index, region) in county_regions.iter().enumerate() {
            for &node in region {
                node_regions[node as usize] = region_index;
                region_district_counts[region_index][assignment[node as usize] as usize] += 1;
            }
        }

        let mut weighted_cut = 0_u64;
        let edge_is_cut = edges
            .iter()
            .map(|edge| {
                let is_cut = assignment[edge.a as usize] != assignment[edge.b as usize];
                if is_cut {
                    weighted_cut += u64::from(edge.weight);
                }
                is_cut
            })
            .collect();
        let (county_fragments, county_splits) = county_totals(&region_district_counts);

        Ok(Self {
            edge_weights: edges.iter().map(|edge| edge.weight).collect(),
            edge_is_cut,
            node_regions,
            region_district_counts,
            district_count,
            total_population,
            weighted_cut,
            county_fragments,
            county_splits,
        })
    }

    /// Updates county presence counts for one already-validated assignment transition.
    pub fn apply_node_change(
        &mut self,
        node: usize,
        old_district: u16,
        new_district: u16,
    ) -> Result<(), ScoreError> {
        if node >= self.node_regions.len() {
            return Err(ScoreError::new("changed node exceeds scoring node count"));
        }
        if old_district >= self.district_count || new_district >= self.district_count {
            return Err(ScoreError::new(
                "changed district exceeds scoring district count",
            ));
        }
        if old_district == new_district {
            return Ok(());
        }

        let region = self.node_regions[node];
        let counts = &mut self.region_district_counts[region];
        let before_present = counts.iter().filter(|count| **count > 0).count() as u32;
        let old_count = &mut counts[old_district as usize];
        if *old_count == 0 {
            return Err(ScoreError::new(
                "old district is absent from the changed node's county region",
            ));
        }
        *old_count -= 1;
        counts[new_district as usize] += 1;
        let after_present = counts.iter().filter(|count| **count > 0).count() as u32;
        adjust_region_totals(
            &mut self.county_fragments,
            &mut self.county_splits,
            before_present,
            after_present,
        );
        Ok(())
    }

    /// Synchronizes one canonical edge after assignment changes have been applied.
    pub fn set_edge_cut(&mut self, edge_index: usize, is_cut: bool) -> Result<(), ScoreError> {
        let Some(previous) = self.edge_is_cut.get_mut(edge_index) else {
            return Err(ScoreError::new("changed edge exceeds scoring edge count"));
        };
        if *previous == is_cut {
            return Ok(());
        }
        let weight = u64::from(self.edge_weights[edge_index]);
        if is_cut {
            self.weighted_cut += weight;
        } else {
            self.weighted_cut -= weight;
        }
        *previous = is_cut;
        Ok(())
    }

    /// Returns the exact current score, recomputing only population deviation from district totals.
    pub fn score(&self, district_populations: &[u64]) -> Result<PlanScore, ScoreError> {
        if district_populations.len() != self.district_count as usize {
            return Err(ScoreError::new(
                "district populations must match scoring district count",
            ));
        }
        Ok(PlanScore {
            weighted_cut: self.weighted_cut,
            county_fragments: self.county_fragments,
            county_splits: self.county_splits,
            max_deviation_ppm: max_deviation_ppm(
                district_populations,
                self.district_count,
                self.total_population,
            ),
        })
    }
}

/// Independently walks every edge and county region. This is the correctness oracle for property
/// tests and diagnostics; request paths should use `IncrementalScore`.
pub fn full_recompute(
    node_count: usize,
    edges: &[WeightedEdge],
    county_regions: &[Vec<u32>],
    assignment: &[u16],
    district_populations: &[u64],
    district_count: u16,
    total_population: u64,
) -> Result<PlanScore, ScoreError> {
    validate_inputs(
        node_count,
        edges,
        county_regions,
        assignment,
        district_count,
        total_population,
    )?;
    if district_populations.len() != district_count as usize {
        return Err(ScoreError::new(
            "district populations must match scoring district count",
        ));
    }

    let weighted_cut = edges
        .iter()
        .filter(|edge| assignment[edge.a as usize] != assignment[edge.b as usize])
        .map(|edge| u64::from(edge.weight))
        .sum();
    let mut county_fragments = 0_u32;
    let mut county_splits = 0_u32;
    let mut present = vec![false; district_count as usize];
    for region in county_regions {
        present.fill(false);
        for &node in region {
            present[assignment[node as usize] as usize] = true;
        }
        let count = present.iter().filter(|value| **value).count() as u32;
        county_fragments += count.saturating_sub(1);
        county_splits += u32::from(count > 1);
    }

    Ok(PlanScore {
        weighted_cut,
        county_fragments,
        county_splits,
        max_deviation_ppm: max_deviation_ppm(
            district_populations,
            district_count,
            total_population,
        ),
    })
}

fn validate_inputs(
    node_count: usize,
    edges: &[WeightedEdge],
    county_regions: &[Vec<u32>],
    assignment: &[u16],
    district_count: u16,
    total_population: u64,
) -> Result<(), ScoreError> {
    if assignment.len() != node_count {
        return Err(ScoreError::new(
            "assignment length must match scoring node count",
        ));
    }
    if district_count == 0 || total_population == 0 {
        return Err(ScoreError::new(
            "district count and total population must be positive",
        ));
    }
    if assignment
        .iter()
        .any(|district| *district >= district_count)
    {
        return Err(ScoreError::new(
            "assignment contains an out-of-range district",
        ));
    }
    if edges.iter().any(|edge| {
        edge.a as usize >= node_count || edge.b as usize >= node_count || edge.a == edge.b
    }) {
        return Err(ScoreError::new("scoring edge contains an invalid node"));
    }

    let mut covered = vec![false; node_count];
    for region in county_regions {
        if region.is_empty() {
            return Err(ScoreError::new("county regions must not be empty"));
        }
        for &node in region {
            let Some(slot) = covered.get_mut(node as usize) else {
                return Err(ScoreError::new("county region contains an invalid node"));
            };
            if *slot {
                return Err(ScoreError::new(
                    "county regions must contain each node exactly once",
                ));
            }
            *slot = true;
        }
    }
    if covered.iter().any(|value| !*value) {
        return Err(ScoreError::new(
            "county regions must contain each node exactly once",
        ));
    }
    Ok(())
}

fn county_totals(region_counts: &[Vec<u32>]) -> (u32, u32) {
    region_counts.iter().fold((0, 0), |totals, counts| {
        let present = counts.iter().filter(|count| **count > 0).count() as u32;
        (
            totals.0 + present.saturating_sub(1),
            totals.1 + u32::from(present > 1),
        )
    })
}

fn adjust_region_totals(
    fragments: &mut u32,
    splits: &mut u32,
    before_present: u32,
    after_present: u32,
) {
    *fragments = (*fragments + after_present.saturating_sub(1))
        .saturating_sub(before_present.saturating_sub(1));
    *splits =
        (*splits + u32::from(after_present > 1)).saturating_sub(u32::from(before_present > 1));
}

fn max_deviation_ppm(
    district_populations: &[u64],
    district_count: u16,
    total_population: u64,
) -> u64 {
    let numerator = district_populations
        .iter()
        .map(|population| {
            (u128::from(*population) * u128::from(district_count))
                .abs_diff(u128::from(total_population))
        })
        .max()
        .unwrap_or_default()
        * PPM_SCALE;
    numerator.div_ceil(u128::from(total_population)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incremental_updates_match_full_recompute() {
        let edges = [
            WeightedEdge {
                a: 0,
                b: 1,
                weight: 4,
            },
            WeightedEdge {
                a: 1,
                b: 2,
                weight: 7,
            },
            WeightedEdge {
                a: 2,
                b: 3,
                weight: 9,
            },
        ];
        let regions = vec![vec![0, 1, 2], vec![3]];
        let mut assignment = vec![0, 0, 1, 1];
        let mut populations = vec![20, 20];
        let mut score = IncrementalScore::new(4, &edges, &regions, &assignment, 2, 40)
            .expect("fixture is valid");

        score.apply_node_change(1, 0, 1).expect("change is valid");
        assignment[1] = 1;
        populations = vec![10, 30];
        score.set_edge_cut(0, true).expect("edge exists");
        score.set_edge_cut(1, false).expect("edge exists");

        assert_eq!(
            score.score(&populations).expect("populations align"),
            full_recompute(4, &edges, &regions, &assignment, &populations, 2, 40)
                .expect("fixture remains valid")
        );
    }

    #[test]
    fn district_relabeling_preserves_every_metric() {
        let edges = [
            WeightedEdge {
                a: 0,
                b: 1,
                weight: 2,
            },
            WeightedEdge {
                a: 1,
                b: 2,
                weight: 3,
            },
            WeightedEdge {
                a: 2,
                b: 3,
                weight: 5,
            },
        ];
        let regions = vec![vec![0, 1, 2], vec![3]];
        let first = full_recompute(4, &edges, &regions, &[0, 0, 1, 1], &[20, 20], 2, 40)
            .expect("fixture is valid");
        let relabeled = full_recompute(4, &edges, &regions, &[1, 1, 0, 0], &[20, 20], 2, 40)
            .expect("relabeled fixture is valid");
        assert_eq!(first, relabeled);
    }
}
