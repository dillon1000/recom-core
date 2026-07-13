//! Maintains a deterministic bounded Pareto archive of scores and assignments. Exact score ties
//! retain the lexicographically smallest assignment, each metric has one protected champion, and
//! non-champions are evicted by the largest objective tuple when the configured cap is exceeded.

use std::collections::BTreeSet;

use crate::{PlanScore, ScoreMetric};

pub const DEFAULT_FRONTIER_CAP: usize = 24;

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
}
