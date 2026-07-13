# frcw distribution oracle

This manual harness compares `recom-core` with the MIT-licensed [`pjrule/frcw.rs`](https://github.com/pjrule/frcw.rs) implementation on the official Virginia precinct geography from [`mggg-states/VA-shapefiles`](https://github.com/mggg-states/VA-shapefiles). It is intentionally excluded from CI because it downloads source geography, builds two native Rust binaries, and runs three 100,000-proposal chains per implementation.

## Pinned inputs

- frcw: `5d6322f0fb9f1bd5830fabb46ff4b069c98c2d46`
- Virginia shapefiles: `63dabd2a58a5ea41b94406235da8a6d1fc6fa1da`
- Seeds: `20260712`, `94915664`, `8675309`
- Population column: `TOTPOP`
- Tolerance: `0.01`
- Proposals per chain: `100,000`
- frcw variant: `cut-edges-rmst`
- recom-core tree attempts per proposal: `1`
- Burn-in: first 20% of accepted samples
- Thinning: every 10th accepted sample after burn-in

The pinned Virginia repository contains the official precinct shapefile rather than a prebuilt NetworkX JSON dual graph. Construct a rook-adjacency dual graph from that source, round the source's floating-point representations of integer population and district attributes, and serialize it with NetworkX `adjacency_data`. The resulting graph has 2,439 nodes, 6,859 undirected edges, one connected component, and SHA3-256 `35244343cd3ecd837ccf204a92b14ac8f799ad531ca14d5bb40cf77981fa0fa1` as reported by frcw.

The enacted `CD_16` assignment exceeds 1% population tolerance, so both chains must start from the same legal 11-district assignment. Generate that assignment with recom-core's no-initial-assignment path using seed `20260712`, write its one-based labels to a `RECOM_SEED` node attribute, and use `RECOM_SEED` as `--assignment-col` for both runners. On the pinned graph, the generated district populations are:

```text
726623, 725352, 729872, 727269, 726250, 727301,
727361, 726276, 729641, 727810, 727269
```

Build the runners:

```bash
git clone https://github.com/pjrule/frcw.rs.git /tmp/frcw.rs
git -C /tmp/frcw.rs checkout 5d6322f0fb9f1bd5830fabb46ff4b069c98c2d46
RUSTFLAGS="-C target-cpu=native" cargo build \
  --manifest-path /tmp/frcw.rs/Cargo.toml --release --bin frcw

cargo build --release --features oracle --bin oracle
```

For each pinned seed, run frcw and recom-core against the same balanced graph:

```bash
/tmp/frcw.rs/target/release/frcw \
  --graph-json /tmp/VA_precincts_balanced.json \
  --assignment-col RECOM_SEED \
  --n-steps 100000 \
  --n-threads 1 \
  --pop-col TOTPOP \
  --rng-seed 20260712 \
  --tol 0.01 \
  --batch-size 1 \
  --variant cut-edges-rmst \
  --writer jsonl \
  --cut-edges-count > /tmp/frcw-20260712.jsonl

target/release/oracle \
  --graph-json /tmp/VA_precincts_balanced.json \
  --pop-col TOTPOP \
  --assignment-col RECOM_SEED \
  --steps 100000 \
  --tolerance 0.01 \
  --seed 20260712 \
  --tree-attempts 1 > /tmp/ours-20260712.jsonl
```

Repeat with seeds `94915664` and `8675309`, then compare all three pairs:

```bash
python3 oracle/compare.py \
  --frcw /tmp/frcw-20260712.jsonl --ours /tmp/ours-20260712.jsonl \
  --frcw /tmp/frcw-94915664.jsonl --ours /tmp/ours-94915664.jsonl \
  --frcw /tmp/frcw-8675309.jsonl --ours /tmp/ours-8675309.jsonl
```

## Results

The approved RMST-aligned 100,000-proposal comparison passed every acceptance threshold on 2026-07-12.

These pinned results predate minimal relabeling. They were produced with the earlier coin-flip label stream and no longer reproduce exactly with the current proposal RNG sequence. The pinned `RECOM_SEED` plan is unaffected because seed generation does not call `choose_balanced_cut`. Cut-edge count is label-invariant, so the distributional conclusion stands. Re-running the full manual procedure (three 100,000-proposal chains across both implementations) is a separate follow-up.

| Seed | Cut-edge KS D | Population KS D |
|---:|---:|---:|
| 20260712 | 0.016523 | 0.010252 |
| 94915664 | 0.036157 | 0.006369 |
| 8675309 | 0.021675 | 0.009533 |

Aggregate cut-edge KS D was `0.011006`. Mean cut edges were `596.791133` for frcw and `596.981182` for recom-core, a `0.031845%` relative difference. Aggregate population KS D was `0.004531`.

The runners both use one random-key Kruskal tree draw per proposal. This matches recom-core's settled tree sampler to frcw's RMST kernel while preserving different RNG streams, so only the post-burn-in distributions—not individual steps—are compared.

## Optional scoring attributes

The pinned frcw comparison intentionally omits county and perimeter attributes, preserving its historical cut-edge distribution. Other GerryChain node-link or adjacency-data inputs may add `--county-col <node attribute>` and `--edge-weight-attr <edge attribute>`. County values derive county-crossing flags and county regions; edge weights must be positive integers and must agree across reverse adjacency entries. Accepted-step JSONL keeps `step`, `cut_edges`, and `district_pops` while also emitting `weighted_cut`, `county_fragments`, `county_splits`, and `max_deviation_ppm` for offline baseline construction.
