# ReCom core

`recom-core` is the deterministic Rust implementation behind Resigned's automatic redistricting. It accepts a population-weighted adjacency graph in compressed sparse row form, creates or validates a contiguous seed partition, and advances a ReCom chain while preserving contiguity and the configured population tolerance.

The same crate is compiled natively for invariant and oracle tests and to `wasm32-unknown-unknown` for the browser worker. Proposal randomness uses a pinned `ChaCha8Rng`; spanning trees use integer random edge keys; population comparisons use integer fixed-point bounds. A seed, graph, assignment, and parameter set therefore produce the same assignments in native and WASM builds. The public generator returns the final seeded chain sample; best-score tracking remains available to a future explicit optimization workflow without collapsing distinct seeds back to a strong reference plan.

## Public web viewer

The repository includes the complete responsive viewer published at [wasm-ar-beta.dillonr.ing](https://wasm-ar-beta.dillonr.ing). It loads authentic congressional block-group or 2024 precinct geography and graph artifacts for all 50 states, layers generated districts over the public `tiles.totallynotacdn.com` planet archive, runs ReCom inside a dedicated Web Worker, and exports generated unit assignments as JSON. The map can switch from categorical district colors to a continuous Republican–even–Democratic gradient based on each generated district's aggregate 2024 presidential two-party share, while generated district boundaries remain visible above the fills. Unit hover inspection and the plan observatory expose population balance, Census demographic counts and shares, county fragmentation, cut edges, 2024 presidential outcomes, seat–vote and mean–median gaps, efficiency gap, and per-district diagnostics. Precinct statistics retain their source election results and allocate Census measures from intersecting source block groups. Generation stays in the browser; the public data service receives ordinary read-only artifact requests and never receives plans or parameters.

Install dependencies and start the viewer from the repository root:

```bash
pnpm install
pnpm dev
```

The development server prints the local URL. The viewer uses the public beta data endpoint by default. Set `VITE_DATA_ORIGIN` to the origin of another service implementing the same `/api/states/{slug}/{file}` manifest and byte-range contract.

The viewer source lives under `web/`:

- `web/src/data.worker.ts` downloads and validates Arrow or precinct JSON statistics, adjacency, assignment, and PMTiles metadata off the UI thread.
- `web/src/recom.worker.ts` owns the WASM chain and posts bounded progress updates.
- `web/src/graph.ts` creates the CSR input and deterministic virtual island links required by published geography.
- `web/src/map.ts` renders real PMTiles geography, planet landmarks and labels, hover states, and generated district boundaries with MapLibre.
- `web/src/analytics.ts` derives balance, demographic, electoral, county, and district-level diagnostics without another data request.
- `web/src/main.ts` owns the unsigned controls, URL sharing, generation lifecycle, analytics views, and JSON export.

Run the full native and browser verification before publishing changes:

```bash
pnpm check
```

## Rebuilding the browser package

From the repository root, run:

```bash
pnpm wasm:build
```

The generated `wasm-bindgen --target web` package is written to the ignored `web/src/wasm/` directory. A normal browser build refreshes it from the crate, so contributors need Rust, the `wasm32-unknown-unknown` target, and `wasm-pack` when building the viewer.

## Algorithm attribution

The balanced-tree-cut proposal structure follows the approach used by [`pjrule/frcw.rs`](https://github.com/pjrule/frcw.rs), distributed under the MIT License, and the broader ReCom algorithm described by the MGGG Redistricting Lab. This implementation is independent because it adds reproducible integer edge priorities, region-aware county surcharges, frozen districts, seed generation, a finishing rebalance pass, and a WASM-safe chunked API.

The `oracle` feature enables the native GerryChain graph runner used for distributional comparisons. See the [pinned oracle procedure and latest results](https://github.com/dillon1000/recom-core/blob/main/oracle/README.md).
