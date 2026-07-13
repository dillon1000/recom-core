/**
 * Locks the explicit separation between neutral generation and Pareto output.
 */
import { describe, expect, it } from "vitest"

import { resultAssignment, resultModeFromQuery, resultStatus } from "./resultMode"
import type { ChainStatus } from "./types"

const status: ChainStatus = {
  bestScore: { countyFragments: 1, countySplits: 1, maxDeviationPpm: 20_000, weightedCut: 8 },
  currentScore: { countyFragments: 3, countySplits: 2, maxDeviationPpm: 30_000, weightedCut: 12 },
  frontierSize: 4,
  stepsAccepted: 80,
  stepsRejected: 20,
}

describe("result mode", () => {
  it("defaults unknown shared URLs to the neutral sample", () => {
    expect(resultModeFromQuery(null)).toBe("sample")
    expect(resultModeFromQuery("optimized")).toBe("optimized")
    expect(resultModeFromQuery("best")).toBe("sample")
  })

  it("keeps assignments and displayed scores on the same output", () => {
    const sample = { a: 1 }
    const optimized = { a: 2 }
    expect(resultAssignment("sample", sample, optimized)).toBe(sample)
    expect(resultAssignment("optimized", sample, optimized)).toBe(optimized)
    expect(resultStatus("sample", status).currentScore).toBe(status.currentScore)
    expect(resultStatus("optimized", status).currentScore).toBe(status.bestScore)
  })
})
