//! Owns deterministic redistricting score types, incremental score bookkeeping, capped Pareto
//! archives, and neutral-ensemble baseline statistics. The solver supplies graph topology,
//! assignments, and population totals; this crate returns comparable scores without consuming RNG.

mod baseline;
mod frontier;
mod score;

pub use baseline::{
    BaselineMetadata, BaselineStatistics, EnsembleBaseline, HistogramBin, PercentileLookup,
};
pub use frontier::{FrontierEntry, ParetoArchive, DEFAULT_FRONTIER_CAP};
pub use score::{
    full_recompute, IncrementalScore, PlanScore, ScoreError, ScoreMetric, WeightedEdge,
};
