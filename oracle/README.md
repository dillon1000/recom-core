# frcw distribution oracle

This manual harness compares `recom-core` with the MIT-licensed [`pjrule/frcw.rs`](https://github.com/pjrule/frcw.rs) implementation on the official Virginia precinct geography from [`mggg-states/VA-shapefiles`](https://github.com/mggg-states/VA-shapefiles). It is intentionally excluded from CI because it downloads source geography, builds two native Rust binaries, and runs three 20,000-step chains per implementation.

## Pinned inputs

- frcw: `5d6322f0fb9f1bd5830fabb46ff4b069c98c2d46`
- Virginia shapefiles: `63dabd2a58a5ea41b94406235da8a6d1fc6fa1da`
- Seeds: `20260712`, `94915664`, `8675309`
- Population column: `TOTPOP`
- Tolerance: `0.01`
- Steps per chain: `20,000`
- frcw variant: `cut-edges-ust`
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

cargo build --manifest-path crates/recom-core/Cargo.toml \
  --release --features oracle --bin oracle
```

For each pinned seed, run frcw and recom-core against the same balanced graph:

```bash
/tmp/frcw.rs/target/release/frcw \
  --graph-json /tmp/VA_precincts_balanced.json \
  --assignment-col RECOM_SEED \
  --n-steps 20000 \
  --n-threads 1 \
  --pop-col TOTPOP \
  --rng-seed 20260712 \
  --tol 0.01 \
  --batch-size 1 \
  --variant cut-edges-ust \
  --writer jsonl \
  --cut-edges-count > /tmp/frcw-20260712.jsonl

crates/recom-core/target/release/oracle \
  --graph-json /tmp/VA_precincts_balanced.json \
  --pop-col TOTPOP \
  --assignment-col RECOM_SEED \
  --steps 20000 \
  --tolerance 0.01 \
  --seed 20260712 \
  --tree-attempts 10 > /tmp/ours-20260712.jsonl
```

Repeat with seeds `94915664` and `8675309`, then compare all three pairs:

```bash
python3 crates/recom-core/oracle/compare.py \
  --frcw /tmp/frcw-20260712.jsonl --ours /tmp/ours-20260712.jsonl \
  --frcw /tmp/frcw-94915664.jsonl --ours /tmp/ours-94915664.jsonl \
  --frcw /tmp/frcw-8675309.jsonl --ours /tmp/ours-8675309.jsonl
```

## Results

The required acceptance threshold was **not met** on 2026-07-12.

| Seed | Cut-edge KS D | Population KS D |
|---:|---:|---:|
| 20260712 | 0.499159 | 0.012469 |
| 94915664 | 0.499400 | 0.011773 |
| 8675309 | 0.503131 | 0.013609 |

Aggregate cut-edge KS D was `0.494103`. Mean cut edges were `655.610138` for frcw and `597.695631` for recom-core, an `8.833681%` relative difference. Aggregate population KS D was `0.007634`.

The mismatch is consistent with the algorithms named in the pinned frcw source: `cut-edges-ust` samples uniform spanning trees with Wilson's algorithm, while recom-core follows its settled random-key Kruskal design, which frcw calls RMST. The plan requires the UST comparison and a cut-edge KS D below `0.05`, so the harness reports failure without substituting `cut-edges-rmst` or relaxing the threshold.
