//! Deterministic ReCom solver shared by native verification tools and the browser WASM worker.
//! Inputs are a validated CSR adjacency graph, unit populations, and chain parameters; outputs are
//! contiguous population-balanced district assignments and cumulative chain status. The public
//! modules expose the pure-Rust core, while `wasm` supplies the target-specific JavaScript boundary.

mod chain;
mod cut;
mod graph;
mod partition;
mod rebalance;
mod rng;
mod seed;
mod tree;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use chain::{
    Chain, ChainParams, ChainStatus, ProposalOutcome, ProposalTrace, RecomVariant, TraceBatch,
};
pub use graph::{CsrGraph, Edge};
pub use partition::{Partition, PopulationBounds};
pub use rebalance::RebalanceStatus;
pub use recom_scoring::{FrontierEntry, PlanScore};

use std::fmt::{Display, Formatter};

/// Validation and proposal failures returned at construction or explicit rebalance boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecomError(String);

impl RecomError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for RecomError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RecomError {}
