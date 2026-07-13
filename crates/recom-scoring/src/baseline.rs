//! Builds and reads static neutral-ensemble metric summaries. Samples produce p1–p99 tables and
//! deterministic histograms; lookup interpolates those tables and clamps outside their stored range.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineMetadata {
    pub seeds: Vec<u64>,
    pub steps: u64,
    pub tolerance: f64,
    pub burn_in: u64,
    pub thinning: u64,
    pub core_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramBin {
    pub min: u64,
    pub max: u64,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineStatistics {
    pub count: u64,
    pub mean: f64,
    pub percentiles: BTreeMap<String, f64>,
    pub histogram: Vec<HistogramBin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnsembleBaseline {
    pub meta: BaselineMetadata,
    pub metrics: BTreeMap<String, BaselineStatistics>,
}

pub trait PercentileLookup {
    /// Returns an interpolated percentile in the stored p1–p99 range, or `None` for an empty or
    /// malformed table. Values beyond the table clamp to its lowest or highest percentile.
    fn percentile_for(&self, value: f64) -> Option<f64>;
}

impl BaselineStatistics {
    /// Summarizes nonempty integer samples. `histogram_bins` controls the maximum bin count; equal
    /// samples collapse to one exact-value bin. Empty input or a zero bin request returns `None`.
    pub fn from_samples(samples: &[u64], histogram_bins: usize) -> Option<Self> {
        if samples.is_empty() || histogram_bins == 0 {
            return None;
        }
        let mut sorted = samples.to_vec();
        sorted.sort_unstable();
        let mean = sorted.iter().map(|value| *value as f64).sum::<f64>() / sorted.len() as f64;
        let percentiles = (1_u8..=99)
            .map(|percentile| {
                (
                    format!("p{percentile}"),
                    quantile(&sorted, f64::from(percentile) / 100.0),
                )
            })
            .collect();
        let histogram = histogram(&sorted, histogram_bins);
        Some(Self {
            count: sorted.len() as u64,
            mean,
            percentiles,
            histogram,
        })
    }

    fn ordered_percentiles(&self) -> Option<Vec<(f64, f64)>> {
        let mut points = self
            .percentiles
            .iter()
            .filter_map(|(key, value)| {
                let percentile = key.strip_prefix('p')?.parse::<f64>().ok()?;
                (percentile.is_finite() && (0.0..=100.0).contains(&percentile) && value.is_finite())
                    .then_some((percentile, *value))
            })
            .collect::<Vec<_>>();
        points.sort_by(|left, right| left.0.total_cmp(&right.0));
        (!points.is_empty()).then_some(points)
    }
}

impl PercentileLookup for BaselineStatistics {
    fn percentile_for(&self, value: f64) -> Option<f64> {
        if !value.is_finite() {
            return None;
        }
        let points = self.ordered_percentiles()?;
        if value <= points[0].1 {
            return Some(points[0].0);
        }
        if value >= points[points.len() - 1].1 {
            return Some(points[points.len() - 1].0);
        }
        for pair in points.windows(2) {
            let (lower_percentile, lower_value) = pair[0];
            let (upper_percentile, upper_value) = pair[1];
            if value <= upper_value {
                if upper_value == lower_value {
                    return Some((lower_percentile + upper_percentile) / 2.0);
                }
                let fraction = (value - lower_value) / (upper_value - lower_value);
                return Some(lower_percentile + fraction * (upper_percentile - lower_percentile));
            }
        }
        None
    }
}

fn quantile(sorted: &[u64], probability: f64) -> f64 {
    let rank = probability * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    let fraction = rank - lower as f64;
    sorted[lower] as f64 + (sorted[upper] as f64 - sorted[lower] as f64) * fraction
}

fn histogram(sorted: &[u64], requested_bins: usize) -> Vec<HistogramBin> {
    let min = sorted[0];
    let max = sorted[sorted.len() - 1];
    if min == max {
        return vec![HistogramBin {
            min,
            max,
            count: sorted.len() as u64,
        }];
    }
    let span = max - min + 1;
    let bin_count = requested_bins.min(span as usize);
    let width = span.div_ceil(bin_count as u64);
    let mut bins = (0..bin_count)
        .map(|index| {
            let bin_min = min + width * index as u64;
            HistogramBin {
                min: bin_min,
                max: (bin_min + width - 1).min(max),
                count: 0,
            }
        })
        .collect::<Vec<_>>();
    for &value in sorted {
        let index = ((value - min) / width) as usize;
        bins[index].count += 1;
    }
    bins
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statistics_are_deterministic_and_complete() {
        let statistics =
            BaselineStatistics::from_samples(&[4, 1, 3, 2], 2).expect("samples are nonempty");
        assert_eq!(statistics.count, 4);
        assert_eq!(statistics.mean, 2.5);
        assert_eq!(statistics.percentiles.len(), 99);
        assert_eq!(
            statistics
                .histogram
                .iter()
                .map(|bin| bin.count)
                .sum::<u64>(),
            4
        );
    }

    #[test]
    fn lookup_interpolates_and_clamps() {
        let statistics = BaselineStatistics {
            count: 2,
            mean: 15.0,
            percentiles: BTreeMap::from([("p10".to_string(), 10.0), ("p90".to_string(), 20.0)]),
            histogram: Vec::new(),
        };
        assert_eq!(statistics.percentile_for(0.0), Some(10.0));
        assert_eq!(statistics.percentile_for(15.0), Some(50.0));
        assert_eq!(statistics.percentile_for(30.0), Some(90.0));
    }

    #[test]
    fn empty_samples_and_empty_tables_are_explicit() {
        assert!(BaselineStatistics::from_samples(&[], 10).is_none());
        let statistics = BaselineStatistics {
            count: 0,
            mean: 0.0,
            percentiles: BTreeMap::new(),
            histogram: Vec::new(),
        };
        assert_eq!(statistics.percentile_for(1.0), None);
    }
}
