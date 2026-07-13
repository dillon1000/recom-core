# ReCom core

`recom-core` is the deterministic Rust implementation behind [Dillon's Redistricting's](https://dillonr.ing/redistricting) automatic redistricting. It accepts a population-weighted adjacency graph in compressed sparse row form, creates or validates a contiguous seed partition, and advances a ReCom chain while preserving contiguity and the configured population tolerance.

The root crate is compiled natively for invariant and oracle tests and to `wasm32-unknown-unknown` for the browser worker. Proposal randomness uses a pinned `ChaCha8Rng`; spanning trees use integer random edge keys; population comparisons use integer fixed-point bounds. A seed, graph, assignment, and parameter set therefore produce the same assignments in native and WASM builds. The public generator returns the final seeded chain sample; Pareto optimization remains separately available through `best_assignment` and the frontier APIs without collapsing distinct seeds back to a strong reference plan.

## Scoring workspace

`crates/recom-scoring` is the solver-independent scoring library. `recom-core` supplies canonical weighted edges, county-region membership, assignment changes, and district populations; `recom-scoring` owns the score types, incremental bookkeeping, full-recompute oracle, Pareto archive, ensemble statistics, and percentile lookup. Scoring never reads the chain RNG, so enabling weights or inspecting the frontier cannot change the proposal stream.

Each `PlanScore` reports:

- `weightedCut`: the sum of weights on district-boundary edges. Omitted weights default to one, making this the canonical cut-edge count.
- `countyFragments`: the sum of `distinct districts present - 1` across county regions.
- `countySplits`: the number of county regions present in multiple districts, retained as a familiar report-only measure.
- `maxDeviationPpm`: the largest district population deviation from ideal in integer parts per million.

The optimization tuple is `(weightedCut, countyFragments, maxDeviationPpm)`, with every objective minimized. The chain retains mutually nondominated plans in a deterministic 24-entry archive. Identical tuples keep the lexicographically smallest assignment; one deterministic champion for each metric is protected; remaining entries are evicted from the lexicographically largest objective tuple downward. `best_assignment` uses min-max-normalized deterministic selection weights across the retained frontier. The public `countySurcharge` control is a bounded `0–50` county-preservation strength: it maps across the full random edge-key range during proposal generation and supplies the county-fragment selection weight to `recom-scoring`. Zero disables both preferences, 25 gives county fragmentation the combined selection weight of boundary cut and deviation, and 50 gives it twice their combined weight. Raw score metrics and Pareto dominance remain unchanged and auditable.

`burstLength` optionally enables optimization by short bursts. Zero is the default and preserves the ordinary neutral chain. A positive value runs that many attempted neutral ReCom proposals, then resumes from `best_assignment`'s weighted Pareto-best plan before starting the next burst. The archive persists across bursts, so the restart target reflects the best retained plan from the full run without biasing proposal acceptance inside a burst.

## Sampler variants

`CutEdgesRmst` is the default sampler and preserves the existing fast behavior: it selects a cut edge, draws an integer-key random minimum spanning tree on the merged districts, and chooses a balanced tree edge. Native callers select it with `variant: RecomVariant::CutEdgesRmst`; WASM and worker callers may omit `variant` or pass `"cutEdgesRmst"`. Its `balance_ub` / `balanceUb` value must remain zero (unset).

`Reversible` is an opt-in advanced sampler implementing Reversible ReCom. It chooses uniformly from every unordered district pair, self-loops when the pair is not adjacent, draws a uniform spanning tree with Wilson's algorithm, and applies the integer Metropolis seam correction. Its stationary distribution is the spanning-tree distribution described by Cannon, Duchin, Randall, and Rule in [*Spanning Tree Methods for Sampling Graph Partitions*](https://arxiv.org/abs/2210.01401), making post-burn-in ensemble summaries statistically interpretable against that target. Self-loops are retained as real chain steps, so reversible runs generally need far more proposals than the standard sampler.

Reversible runs require a positive `balance_ub` / `balanceUb` value (`40` is the viewer default). This value is the upper bound `M` on balanced edges in a sampled tree; proposals exceeding it self-loop. Reversible construction rejects positive county preservation, positive burst length, and nonempty frozen districts because those features change the proposal kernel or state space. The standard variant rejects a nonzero balance bound. The viewer exposes Reversible as an optional Sampler selection and disables the incompatible controls automatically.

## Proposal tracing

`Chain::step_traced` advances the identical deterministic proposal stream while returning one compact `ProposalTrace` for every attempted step and every restart that changes the plan. Accepted and `burstRestart` events reference aligned node and district delta arrays; native labels remain zero-based and the WASM boundary converts them to the browser's one-based contract. Rejected events retain the preceding score and report `noEligibleBoundary`, `noSpanningTree`, or `noBalancedCut`; reversible traces additionally report `nonAdjacentPair`, `balanceBoundExceeded`, and `seamRejected` self-loops. Restarts count separately from accepted and rejected attempts, and all event numbers remain unique and monotonic. Browser workers retain a full assignment checkpoint every 200 attempts, so any individual event can be reconstructed by applying at most one chunk of deltas instead of storing thousands of complete plans. The ordinary `Chain::step` path remains available when trace allocation is unnecessary.

## Optional scoring artifacts

The standalone viewer accepts two optional manifest files without changing the existing adjacency contract:

- `files.unitAdjacencyWeights` names a `Record<string, number[]>` JSON artifact. Every positive integer-meter row must align index-for-index with the unit's neighbor row, and reverse directed entries must agree. Missing artifacts omit the WASM weight array, so every edge defaults to one; deterministic virtual island links also use one.
- `files.ensembleBaseline` names a JSON artifact with `{ meta, metrics }`. Each metric contains `count`, `mean`, a `p1` through `p99` percentile table, and histogram bins. The viewer validates the artifact and performs clamped linear percentile lookup, but intentionally does not display percentile UI yet.

Artifact generation, state regeneration, publication, and storage operations are offline data-pipeline responsibilities and are not performed by this repository's viewer request path.

## Public web viewer

The repository includes the complete responsive viewer published at [wasm-ar-beta.dillonr.ing](https://wasm-ar-beta.dillonr.ing). It loads authentic congressional block-group or 2024 precinct geography and graph artifacts for all 50 states, layers generated districts over the public `tiles.totallynotacdn.com` planet archive, runs ReCom inside a dedicated Web Worker, and exports generated unit assignments as JSON. Results can switch explicitly between the final neutral chain sample and `recom-scoring`'s deterministic Pareto-selected optimization output, so optimization never silently replaces seed-driven generation. The optional Sampler control selects Standard or Reversible ReCom and preserves the selection and balance bound in shared URLs and JSON exports. The Burst length control enables weighted Pareto short-burst restarts and is preserved in shared URLs and JSON exports. The Proposal Explorer records every accepted or rejected attempt and each plan-changing restart, then links timeline playback, rejection explanations, final-frontier filtering, a weighted-cut/county-fragment score cloud, election-seat filters, persistent bookmarks, shareable proposal URLs, two-plan change highlighting, and branch-from-proposal generation directly to the map. The map can switch from categorical district colors to a continuous Republican–even–Democratic gradient based on each generated district's aggregate 2024 presidential two-party share, while generated district boundaries remain visible above the fills. Unit hover inspection and the plan observatory expose population balance, Census demographic counts and shares, county fragmentation, weighted boundary cut, 2024 presidential outcomes, seat–vote and mean–median gaps, efficiency gap, and per-district diagnostics. Precinct statistics retain their source election results and allocate Census measures from intersecting source block groups. Generation stays in the browser; the public data service receives ordinary read-only artifact requests and never receives plans or parameters.

Install dependencies and start the viewer from the repository root:

```bash
pnpm install
pnpm dev
```

The development server prints the local URL. The viewer uses the public beta data endpoint by default. Set `VITE_DATA_ORIGIN` to the origin of another service implementing the same `/api/states/{slug}/{file}` manifest and byte-range contract.

The viewer source lives under `web/`:

- `web/src/data.worker.ts` downloads and validates Arrow or precinct JSON statistics, adjacency, assignment, optional scoring artifacts, and PMTiles metadata off the UI thread.
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

The balanced-tree-cut proposal structure and Reversible ReCom kernel follow the approach used by [`pjrule/frcw.rs`](https://github.com/pjrule/frcw.rs), distributed under the MIT License, and the broader ReCom algorithm described by the MGGG Redistricting Lab. Short-burst optimization follows Cannon et al., [*Voting Rights, Markov Chains, and Optimization by Short Bursts*](https://doi.org/10.1007/s11009-023-09994-1), adapted here to restart from the persistent weighted Pareto archive. This implementation is independent because it adds reproducible integer acceptance arithmetic and edge priorities, minimal relabeling, region-aware county surcharges, frozen districts, seed generation, a finishing rebalance pass, and a WASM-safe chunked API.

The `oracle` feature enables the native GerryChain graph runner used for distributional comparisons. See the [pinned oracle procedure and latest results](https://github.com/dillon1000/recom-core/blob/main/oracle/README.md).

# Notices
- When developing, AI tools such as OpenAI's Codex and Anthropic's Claude Code were used to generate partial or whole files or functions in this codebase. While I believe I have done my due dilligence reviewing the changes proposed, there may be some things that have slipped through the cracks. Please be sure to verify any outputs that you may receive. 
- The app is not an official election system, government system, legal service, compliance service, or source of certified election results. District, demographic, geographic, contiguity, compactness, and election-related outputs may be incomplete, stale, inaccurate, or unsuitable for legal compliance. You should independently verify any output before relying on it.
