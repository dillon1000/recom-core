import { describe, expect, it } from "vitest"

import { parseEnsembleBaseline, percentileFor } from "./ensembleBaseline"
import type { EnsembleBaseline } from "./types"

const baseline: EnsembleBaseline = {
  meta: {
    seeds: [1, 2, 3],
    steps: 100_000,
    tolerance: 0.01,
    burnIn: 20_000,
    thinning: 10,
    coreVersion: "0.1.0",
  },
  metrics: {
    weightedCut: {
      count: 2,
      mean: 15,
      percentiles: { p10: 10, p50: 15, p90: 20 },
      histogram: [{ min: 10, max: 20, count: 2 }],
    },
  },
}

describe("ensemble baseline lookup", () => {
  it("interpolates between stored percentiles", () => {
    expect(percentileFor(baseline, "weightedCut", 12.5)).toBe(30)
    expect(percentileFor(baseline, "weightedCut", 17.5)).toBe(70)
  })

  it("clamps outside the stored percentile range", () => {
    expect(percentileFor(baseline, "weightedCut", 0)).toBe(10)
    expect(percentileFor(baseline, "weightedCut", 30)).toBe(90)
  })

  it("returns null for missing or empty metrics", () => {
    expect(percentileFor(undefined, "weightedCut", 10)).toBeNull()
    expect(percentileFor(baseline, "countyFragments", 10)).toBeNull()
    expect(percentileFor({ ...baseline, metrics: {
      empty: { count: 0, mean: 0, percentiles: {}, histogram: [] },
    } }, "empty", 10)).toBeNull()
  })

  it("validates artifact structure before viewer consumption", () => {
    expect(parseEnsembleBaseline(baseline)).toEqual(baseline)
    expect(() => parseEnsembleBaseline({ meta: {}, metrics: {} })).toThrow(/metadata/)
    expect(() => parseEnsembleBaseline({ ...baseline, metrics: { broken: { count: -1 } } }))
      .toThrow(/broken/)
  })
})
