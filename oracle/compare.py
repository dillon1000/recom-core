#!/usr/bin/env python3
"""Compare thinned post-burn-in frcw and recom-core JSONL distributions.

Inputs are paired frcw JSONL streams and recom-core oracle streams. The script reconstructs frcw's
full district-population vector from its two-district updates, applies the documented 20% burn-in
and 10-step thinning, then reports exact two-sample KS D statistics and cut-edge mean agreement.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


KS_LIMIT = 0.05
MEAN_RELATIVE_LIMIT = 0.05


@dataclass(frozen=True)
class Sample:
    cut_edges: int
    district_pops: tuple[int, ...]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare frcw and recom-core ReCom distributions",
    )
    parser.add_argument(
        "--frcw",
        action="append",
        required=True,
        type=Path,
        help="frcw JSONL path; repeat once per seed",
    )
    parser.add_argument(
        "--ours",
        action="append",
        required=True,
        type=Path,
        help="recom-core oracle JSONL path; repeat in matching seed order",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    if len(arguments.frcw) != len(arguments.ours):
        raise SystemExit("--frcw and --ours must be supplied the same number of times")

    aggregate_frcw: list[Sample] = []
    aggregate_ours: list[Sample] = []
    all_cut_ks_pass = True
    for index, (frcw_path, ours_path) in enumerate(zip(arguments.frcw, arguments.ours), start=1):
        frcw_samples = thin_after_burn_in(load_frcw(frcw_path))
        ours_samples = thin_after_burn_in(load_ours(ours_path))
        aggregate_frcw.extend(frcw_samples)
        aggregate_ours.extend(ours_samples)
        cut_d = ks_statistic(
            [sample.cut_edges for sample in frcw_samples],
            [sample.cut_edges for sample in ours_samples],
        )
        pop_d = ks_statistic(
            flatten(sample.district_pops for sample in frcw_samples),
            flatten(sample.district_pops for sample in ours_samples),
        )
        all_cut_ks_pass = all_cut_ks_pass and cut_d < KS_LIMIT
        print(f"seed_pair={index} samples_frcw={len(frcw_samples)} samples_ours={len(ours_samples)}")
        print(f"  cut_edges_ks_d={cut_d:.6f} {'PASS' if cut_d < KS_LIMIT else 'FAIL'}")
        print(f"  district_pops_ks_d={pop_d:.6f} {'PASS' if pop_d < KS_LIMIT else 'FAIL'}")

    frcw_cut_edges = [sample.cut_edges for sample in aggregate_frcw]
    ours_cut_edges = [sample.cut_edges for sample in aggregate_ours]
    aggregate_cut_d = ks_statistic(frcw_cut_edges, ours_cut_edges)
    aggregate_pop_d = ks_statistic(
        flatten(sample.district_pops for sample in aggregate_frcw),
        flatten(sample.district_pops for sample in aggregate_ours),
    )
    frcw_mean = statistics.fmean(frcw_cut_edges)
    ours_mean = statistics.fmean(ours_cut_edges)
    mean_relative_difference = abs(ours_mean - frcw_mean) / frcw_mean
    mean_pass = mean_relative_difference < MEAN_RELATIVE_LIMIT
    overall_pass = all_cut_ks_pass and mean_pass
    print("aggregate")
    print(
        f"  cut_edges_ks_d={aggregate_cut_d:.6f} "
        f"{'PASS' if aggregate_cut_d < KS_LIMIT else 'FAIL'}",
    )
    print(
        f"  district_pops_ks_d={aggregate_pop_d:.6f} "
        f"{'PASS' if aggregate_pop_d < KS_LIMIT else 'FAIL'}",
    )
    print(f"  frcw_mean_cut_edges={frcw_mean:.6f}")
    print(f"  ours_mean_cut_edges={ours_mean:.6f}")
    print(
        f"  mean_relative_difference={mean_relative_difference:.6%} "
        f"{'PASS' if mean_pass else 'FAIL'}",
    )
    print(f"acceptance={'PASS' if overall_pass else 'FAIL'}")
    return 0 if overall_pass else 1


def load_frcw(path: Path) -> list[Sample]:
    district_pops: list[int] | None = None
    samples: list[Sample] = []
    for record in json_lines(path):
        if "init" in record:
            district_pops = [int(value) for value in record["init"]["populations"]]
            continue
        if "step" not in record:
            continue
        if district_pops is None:
            raise ValueError(f"{path} contains a step before its init record")
        step = record["step"]
        district_a, district_b = (int(value) for value in step["dists"])
        population_a, population_b = (int(value) for value in step["populations"])
        district_pops[district_a] = population_a
        district_pops[district_b] = population_b
        samples.append(
            Sample(
                cut_edges=int(step["num_cut_edges"]),
                district_pops=tuple(district_pops),
            ),
        )
    return require_samples(path, samples)


def load_ours(path: Path) -> list[Sample]:
    samples = [
        Sample(
            cut_edges=int(record["cut_edges"]),
            district_pops=tuple(int(value) for value in record["district_pops"]),
        )
        for record in json_lines(path)
    ]
    return require_samples(path, samples)


def json_lines(path: Path) -> Iterable[dict[str, object]]:
    with path.open(encoding="utf-8") as lines:
        for line_number, line in enumerate(lines, start=1):
            if line.strip():
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"invalid JSON at {path}:{line_number}: {error}") from error


def require_samples(path: Path, samples: list[Sample]) -> list[Sample]:
    if not samples:
        raise ValueError(f"{path} contains no accepted-step samples")
    return samples


def thin_after_burn_in(samples: list[Sample]) -> list[Sample]:
    burn_in = len(samples) // 5
    thinned = samples[burn_in::10]
    if not thinned:
        raise ValueError("burn-in and thinning removed every sample")
    return thinned


def flatten(values: Iterable[Iterable[int]]) -> list[int]:
    return [value for collection in values for value in collection]


def ks_statistic(left: list[int], right: list[int]) -> float:
    if not left or not right:
        raise ValueError("KS samples cannot be empty")
    left = sorted(left)
    right = sorted(right)
    left_index = 0
    right_index = 0
    maximum = 0.0
    for value in sorted(set(left + right)):
        while left_index < len(left) and left[left_index] <= value:
            left_index += 1
        while right_index < len(right) and right[right_index] <= value:
            right_index += 1
        maximum = max(
            maximum,
            abs(left_index / len(left) - right_index / len(right)),
        )
    return maximum


if __name__ == "__main__":
    sys.exit(main())
