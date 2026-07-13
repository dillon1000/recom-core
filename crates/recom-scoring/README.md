# recom-scoring

`recom-scoring` is the deterministic scoring library used by `recom-core`. It has no proposal or random-number code: callers provide immutable topology plus validated partition changes, and the library maintains exact plan metrics, a bounded Pareto archive, and neutral-ensemble summaries.

## Plan scores

`PlanScore` contains `weighted_cut`, `county_fragments`, `county_splits`, and `max_deviation_ppm`. Optimization uses only `(weighted_cut, county_fragments, max_deviation_ppm)`; `county_splits` is report-only. `IncrementalScore` updates weighted cut when an edge changes cut status and county presence when a node changes district, then recomputes population deviation from the district totals in O(districts). `full_recompute` independently walks every edge and county region for tests and diagnostics.

Weights are `u32` values on canonical undirected edges. A solver that has no perimeter artifact supplies one for every edge, preserving ordinary cut-edge counts. County regions must cover each node exactly once, and fragments count district-label presence rather than connected pieces so incremental updates remain local.

## Pareto archive

`ParetoArchive` minimizes all three optimization objectives and defaults to 24 entries. It removes dominated entries, rejects dominated candidates, canonicalizes equal objective tuples to the lexicographically smallest assignment, and sorts entries by objective tuple and assignment. When the archive exceeds its cap, exactly one deterministic champion for each metric is protected and the lexicographically largest non-champion tuple is evicted. `best()` therefore returns the compatibility plan with the lexicographically smallest objective tuple.

## Ensemble baselines

`BaselineStatistics::from_samples` produces a count, mean, deterministic p1–p99 table, and bounded histogram from nonempty integer samples. `PercentileLookup::percentile_for` linearly interpolates within a stored table and clamps outside its endpoints; empty or malformed tables return `None`. `EnsembleBaseline` provides the serializable `{ meta, metrics }` artifact contract consumed by the standalone viewer.
