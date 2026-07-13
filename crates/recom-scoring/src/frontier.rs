//! Maintains a deterministic bounded Pareto archive of scores and assignments. Exact score ties
//! retain the lexicographically smallest assignment, each metric has one protected champion, and
//! non-champions are evicted by the largest objective tuple when the configured cap is exceeded.

use std::collections::BTreeSet;

use crate::{PlanScore, ScoreMetric};

pub const DEFAULT_FRONTIER_CAP: usize = 24;
pub const MAX_COUNTY_PRESERVATION: u32 = 50;

/// Relative weights used to select one optimized plan from the nondominated archive. Metrics are
/// min-max normalized across the retained frontier before weighting, so values with different units
/// remain comparable and callers can express preferences without changing the raw score contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionWeights {
    pub weighted_cut: u32,
    pub county_fragments: u32,
    pub max_deviation_ppm: u32,
}

impl SelectionWeights {
    /// Maps the viewer's documented 0–50 county-preservation control to selection weights. Zero
    /// removes county fragments from final selection, 25 gives them the combined weight of boundary
    /// cut and deviation, and 50 makes them twice as influential as those objectives combined.
    pub const fn for_county_preservation(strength: u32) -> Self {
        Self {
            weighted_cut: 25,
            county_fragments: strength.saturating_mul(2),
            max_deviation_ppm: 25,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontierEntry {
    pub score: PlanScore,
    pub assignment: Vec<u16>,
}

#[derive(Debug, Clone)]
pub struct ParetoArchive {
    cap: usize,
    entries: Vec<FrontierEntry>,
}

impl Default for ParetoArchive {
    fn default() -> Self {
        Self::new(DEFAULT_FRONTIER_CAP)
    }
}

impl ParetoArchive {
    /// A cap of at least three guarantees that one champion for every optimization metric can be
    /// retained even when the champions are distinct.
    pub fn new(cap: usize) -> Self {
        assert!(
            cap >= ScoreMetric::ALL.len(),
            "Pareto archive cap must be at least three"
        );
        Self {
            cap,
            entries: Vec::new(),
        }
    }

    pub fn entries(&self) -> &[FrontierEntry] {
        &self.entries
    }

    pub fn best(&self) -> Option<&FrontierEntry> {
        self.entries.first()
    }

    /// Selects one frontier entry by deterministic normalized weighted loss. Exact weighted ties
    /// fall back to the stable objective tuple and assignment ordering used by the archive.
    pub fn best_with_weights(&self, weights: SelectionWeights) -> Option<&FrontierEntry> {
        let ranges = ScoreRanges::from_entries(&self.entries)?;
        self.entries.iter().min_by_key(|entry| {
            (
                ranges.weighted_loss(entry.score, weights),
                entry.score.objective_tuple(),
                &entry.assignment,
            )
        })
    }

    /// Inserts a nondominated score, removes entries it dominates, canonicalizes exact score ties,
    /// and applies the cap. Returns true when the archive's observable contents changed.
    pub fn insert(&mut self, score: PlanScore, assignment: Vec<u16>) -> bool {
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|entry| entry.score.objective_tuple() == score.objective_tuple())
        {
            if assignment < existing.assignment {
                existing.assignment = assignment;
                existing.score = score;
                self.sort_entries();
                return true;
            }
            return false;
        }
        if self
            .entries
            .iter()
            .any(|entry| entry.score.dominates(score))
        {
            return false;
        }

        self.entries.retain(|entry| !score.dominates(entry.score));
        self.entries.push(FrontierEntry { score, assignment });
        self.sort_entries();
        if self.entries.len() > self.cap {
            self.evict_one();
        }
        true
    }

    fn sort_entries(&mut self) {
        self.entries.sort_by(|left, right| {
            left.score
                .objective_tuple()
                .cmp(&right.score.objective_tuple())
                .then_with(|| left.assignment.cmp(&right.assignment))
        });
    }

    fn evict_one(&mut self) {
        let champions = ScoreMetric::ALL
            .iter()
            .filter_map(|metric| {
                self.entries
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, entry)| {
                        (
                            metric.value(entry.score),
                            entry.score.objective_tuple(),
                            &entry.assignment,
                        )
                    })
                    .map(|(index, _)| index)
            })
            .collect::<BTreeSet<_>>();
        let eviction = self
            .entries
            .iter()
            .enumerate()
            .filter(|(index, _)| !champions.contains(index))
            .max_by(|(_, left), (_, right)| {
                left.score
                    .objective_tuple()
                    .cmp(&right.score.objective_tuple())
                    .then_with(|| left.assignment.cmp(&right.assignment))
            })
            .map(|(index, _)| index)
            .expect("a capped archive always has a non-champion eviction candidate");
        self.entries.remove(eviction);
    }
}

#[derive(Debug, Clone, Copy)]
struct ScoreRanges {
    weighted_cut: (u64, u64),
    county_fragments: (u64, u64),
    max_deviation_ppm: (u64, u64),
}

impl ScoreRanges {
    fn from_entries(entries: &[FrontierEntry]) -> Option<Self> {
        let first = entries.first()?.score;
        let mut ranges = Self {
            weighted_cut: (first.weighted_cut, first.weighted_cut),
            county_fragments: (
                u64::from(first.county_fragments),
                u64::from(first.county_fragments),
            ),
            max_deviation_ppm: (first.max_deviation_ppm, first.max_deviation_ppm),
        };
        for entry in entries.iter().skip(1) {
            extend(&mut ranges.weighted_cut, entry.score.weighted_cut);
            extend(
                &mut ranges.county_fragments,
                u64::from(entry.score.county_fragments),
            );
            extend(&mut ranges.max_deviation_ppm, entry.score.max_deviation_ppm);
        }
        Some(ranges)
    }

    fn weighted_loss(self, score: PlanScore, weights: SelectionWeights) -> u128 {
        normalized_loss(score.weighted_cut, self.weighted_cut) * u128::from(weights.weighted_cut)
            + normalized_loss(u64::from(score.county_fragments), self.county_fragments)
                * u128::from(weights.county_fragments)
            + normalized_loss(score.max_deviation_ppm, self.max_deviation_ppm)
                * u128::from(weights.max_deviation_ppm)
    }
}

fn extend(range: &mut (u64, u64), value: u64) {
    range.0 = range.0.min(value);
    range.1 = range.1.max(value);
}

fn normalized_loss(value: u64, range: (u64, u64)) -> u128 {
    const SCALE: u128 = 1_000_000;
    if range.0 == range.1 {
        return 0;
    }
    u128::from(value - range.0) * SCALE / u128::from(range.1 - range.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(weighted_cut: u64, county_fragments: u32, deviation: u64) -> PlanScore {
        PlanScore {
            weighted_cut,
            county_fragments,
            county_splits: county_fragments.min(1),
            max_deviation_ppm: deviation,
        }
    }

    #[test]
    fn dominance_removes_only_dominated_entries() {
        let mut archive = ParetoArchive::default();
        archive.insert(score(8, 8, 8), vec![2]);
        archive.insert(score(7, 9, 8), vec![3]);
        archive.insert(score(7, 7, 7), vec![1]);
        assert_eq!(
            archive.entries(),
            &[FrontierEntry {
                score: score(7, 7, 7),
                assignment: vec![1]
            }]
        );
    }

    #[test]
    fn exact_score_ties_keep_lexicographically_smallest_assignment() {
        let mut archive = ParetoArchive::default();
        archive.insert(score(5, 6, 7), vec![2, 1]);
        archive.insert(score(5, 6, 7), vec![1, 2]);
        archive.insert(score(5, 6, 7), vec![2, 0]);
        assert_eq!(archive.entries().len(), 1);
        assert_eq!(archive.entries()[0].assignment, vec![1, 2]);
    }

    #[test]
    fn cap_retains_one_deterministic_champion_per_metric() {
        let mut archive = ParetoArchive::new(3);
        for value in 0..12_u64 {
            archive.insert(
                score(value + 1, (12 - value) as u32, value.abs_diff(6) + 1),
                vec![value as u16],
            );
        }
        assert_eq!(archive.entries().len(), 3);
        for metric in ScoreMetric::ALL {
            let global_min = (0..12_u64)
                .map(|value| {
                    metric.value(score(value + 1, (12 - value) as u32, value.abs_diff(6) + 1))
                })
                .min()
                .expect("fixture has scores");
            assert!(archive
                .entries()
                .iter()
                .any(|entry| metric.value(entry.score) == global_min));
        }
    }

    #[test]
    fn best_is_lexicographically_smallest_objective_tuple() {
        let mut archive = ParetoArchive::default();
        archive.insert(score(4, 9, 2), vec![1]);
        archive.insert(score(5, 3, 2), vec![2]);
        assert_eq!(
            archive.best().expect("archive is populated").score,
            score(4, 9, 2)
        );
    }

    #[test]
    fn county_preference_changes_normalized_frontier_selection() {
        let compact = score(1, 10, 1);
        let preserved = score(2, 0, 2);
        let mut archive = ParetoArchive::default();
        archive.insert(compact, vec![1]);
        archive.insert(preserved, vec![2]);

        assert_eq!(
            archive
                .best_with_weights(SelectionWeights::for_county_preservation(0))
                .expect("archive is populated")
                .score,
            compact
        );
        assert_eq!(
            archive
                .best_with_weights(SelectionWeights::for_county_preservation(50))
                .expect("archive is populated")
                .score,
            preserved
        );
    }
}
