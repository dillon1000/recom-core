//! Defines the minimal wasm-bindgen boundary consumed by TypeScript. JavaScript supplies one-based
//! district labels and a bigint seed; this layer validates and converts them to the pure Rust
//! zero-based core, then serializes status objects and one-based assignments back to typed arrays.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::{Chain as CoreChain, ChainParams, CsrGraph, RecomError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmChainParams {
    districts: u16,
    seed: u64,
    pop_tolerance: f64,
    county_surcharge: u64,
    tree_attempts: u32,
    #[serde(default)]
    frozen_districts: Option<Vec<u16>>,
    #[serde(default)]
    initial_assignment: Option<Vec<u16>>,
}

#[wasm_bindgen(js_name = Chain)]
pub struct WasmChain {
    inner: CoreChain,
}

#[wasm_bindgen]
impl WasmChain {
    #[wasm_bindgen(constructor)]
    pub fn new(
        offsets: &[u32],
        neighbors: &[u32],
        edge_county_cross: &[u8],
        populations: &[u32],
        params: JsValue,
    ) -> Result<WasmChain, JsError> {
        let raw: WasmChainParams = serde_wasm_bindgen::from_value(params)
            .map_err(|error| JsError::new(&format!("invalid chain parameters: {error}")))?;
        let frozen_districts = raw
            .frozen_districts
            .unwrap_or_default()
            .into_iter()
            .map(|district| one_to_zero(district, raw.districts, "frozen district"))
            .collect::<Result<Vec<_>, _>>()?;
        let initial_assignment = raw
            .initial_assignment
            .map(|assignment| {
                assignment
                    .into_iter()
                    .map(|district| one_to_zero(district, raw.districts, "initial assignment"))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let graph = CsrGraph::new(
            offsets.to_vec(),
            neighbors.to_vec(),
            edge_county_cross.to_vec(),
        )
        .map_err(js_error)?;
        let inner = CoreChain::new(
            graph,
            populations.to_vec(),
            ChainParams {
                districts: raw.districts,
                seed: raw.seed,
                pop_tolerance: raw.pop_tolerance,
                county_surcharge: raw.county_surcharge,
                tree_attempts: raw.tree_attempts,
                frozen_districts,
            },
            initial_assignment,
        )
        .map_err(js_error)?;
        Ok(Self { inner })
    }

    pub fn step(&mut self, count: u32) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&self.inner.step(count))
            .map_err(|error| JsError::new(&format!("could not serialize chain status: {error}")))
    }

    pub fn rebalance(&mut self, tolerance: f64) -> Result<JsValue, JsError> {
        let status = self.inner.rebalance(tolerance).map_err(js_error)?;
        serde_wasm_bindgen::to_value(&status).map_err(|error| {
            JsError::new(&format!("could not serialize rebalance status: {error}"))
        })
    }

    pub fn assignment(&self) -> Vec<u16> {
        one_based_assignment(self.inner.assignment())
    }

    pub fn best_assignment(&self) -> Vec<u16> {
        one_based_assignment(self.inner.best_assignment())
    }
}

fn one_to_zero(district: u16, districts: u16, field: &str) -> Result<u16, JsError> {
    if district == 0 || district > districts {
        return Err(JsError::new(&format!(
            "{field} labels must be between 1 and {districts}"
        )));
    }
    Ok(district - 1)
}

fn one_based_assignment(assignment: &[u16]) -> Vec<u16> {
    assignment.iter().map(|district| district + 1).collect()
}

fn js_error(error: RecomError) -> JsError {
    JsError::new(&error.to_string())
}
