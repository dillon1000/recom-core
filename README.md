# ReCom core

`recom-core` is the deterministic Rust implementation behind Resigned's automatic redistricting. It accepts a population-weighted adjacency graph in compressed sparse row form, creates or validates a contiguous seed partition, and advances a ReCom chain while preserving contiguity and the configured population tolerance.

The same crate is compiled natively for invariant and oracle tests and to `wasm32-unknown-unknown` for the browser worker. Proposal randomness uses a pinned `ChaCha8Rng`; spanning trees use integer random edge keys; population comparisons use integer fixed-point bounds. A seed, graph, assignment, and parameter set therefore produce the same assignments in native and WASM builds.

## Rebuilding the browser package

From the repository root, run:

```bash
pnpm wasm:build
```

The generated `wasm-bindgen --target web` package is committed at `src/features/autoRedistrict/wasm/`, so ordinary JavaScript contributors do not need Rust installed.

## Algorithm attribution

The balanced-tree-cut proposal structure follows the approach used by [`pjrule/frcw.rs`](https://github.com/pjrule/frcw.rs), distributed under the MIT License, and the broader ReCom algorithm described by the MGGG Redistricting Lab. This implementation is independent because it adds reproducible integer edge priorities, region-aware county surcharges, frozen districts, seed generation, a finishing rebalance pass, and a WASM-safe chunked API.

The `oracle` feature enables the native GerryChain graph runner used for distributional comparisons. See the [pinned oracle procedure and latest results](https://github.com/dillon1000/recom-core/blob/main/oracle/README.md).
