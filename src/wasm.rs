//! Defines the minimal wasm-bindgen boundary consumed by TypeScript. JavaScript supplies one-based
//! district labels and a bigint seed; this layer validates and converts them to the pure Rust
//! zero-based core, then serializes status objects and one-based assignments back to typed arrays.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::{Chain as CoreChain, ChainParams, CsrGraph, RecomError, RecomVariant};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmChainParams {
    districts: u16,
    seed: u64,
    pop_tolerance: f64,
    county_surcharge: f64,
    tree_attempts: u32,
    #[serde(default)]
    burst_length: Option<u32>,
    #[serde(default)]
    frozen_districts: Option<Vec<u16>>,
    #[serde(default)]
    initial_assignment: Option<Vec<u16>>,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    balance_ub: Option<u32>,
}

#[wasm_bindgen]
pub struct Chain {
    inner: CoreChain,
}

#[wasm_bindgen]
impl Chain {
    #[wasm_bindgen(constructor)]
    pub fn new(
        offsets: &[u32],
        neighbors: &[u32],
        edge_county_cross: &[u8],
        edge_weights: JsValue,
        populations: &[u32],
        params: JsValue,
    ) -> Result<Chain, JsError> {
        let raw: WasmChainParams = serde_wasm_bindgen::from_value(params)
            .map_err(|error| JsError::new(&format!("invalid chain parameters: {error}")))?;
        let variant = match raw.variant.as_deref().unwrap_or("cutEdgesRmst") {
            "cutEdgesRmst" => RecomVariant::CutEdgesRmst,
            "reversible" => RecomVariant::Reversible,
            variant => {
                return Err(JsError::new(&format!(
                    "unknown ReCom variant {variant:?}; expected cutEdgesRmst or reversible"
                )));
            }
        };
        if !raw.county_surcharge.is_finite()
            || raw.county_surcharge < 0.0
            || raw.county_surcharge.fract() != 0.0
            || raw.county_surcharge > f64::from(recom_scoring::MAX_COUNTY_PRESERVATION)
        {
            return Err(JsError::new(
                "county preservation must be an integer between 0 and 50",
            ));
        }
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
        let edge_weights = if edge_weights.is_null() || edge_weights.is_undefined() {
            None
        } else if edge_weights.is_instance_of::<js_sys::Uint32Array>() {
            Some(js_sys::Uint32Array::from(edge_weights).to_vec())
        } else {
            return Err(JsError::new(
                "edge weights must be a Uint32Array, null, or undefined",
            ));
        };
        let graph = CsrGraph::new(
            offsets.to_vec(),
            neighbors.to_vec(),
            edge_county_cross.to_vec(),
            edge_weights,
        )
        .map_err(js_error)?;
        let inner = CoreChain::new(
            graph,
            populations.to_vec(),
            ChainParams {
                districts: raw.districts,
                seed: raw.seed,
                pop_tolerance: raw.pop_tolerance,
                county_surcharge: raw.county_surcharge as u32,
                tree_attempts: raw.tree_attempts,
                burst_length: raw.burst_length.unwrap_or_default(),
                frozen_districts,
                variant,
                balance_ub: raw.balance_ub.unwrap_or_default(),
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

    pub fn step_traced(&mut self, count: u32) -> Result<JsValue, JsError> {
        let mut batch = self.inner.step_traced(count);
        for district in &mut batch.changed_districts {
            *district += 1;
        }
        serde_wasm_bindgen::to_value(&batch)
            .map_err(|error| JsError::new(&format!("could not serialize proposal trace: {error}")))
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

    pub fn frontier(&self) -> Result<JsValue, JsError> {
        let scores = self
            .inner
            .frontier()
            .iter()
            .map(|entry| entry.score)
            .collect::<Vec<_>>();
        serde_wasm_bindgen::to_value(&scores)
            .map_err(|error| JsError::new(&format!("could not serialize frontier: {error}")))
    }

    pub fn frontier_assignment(&self, index: usize) -> Result<Vec<u16>, JsError> {
        let assignment = self
            .inner
            .frontier()
            .get(index)
            .ok_or_else(|| JsError::new("frontier assignment index is out of range"))?;
        Ok(one_based_assignment(&assignment.assignment))
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
