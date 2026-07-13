import { describe, expect, it } from "vitest"

import { computeAnalytics } from "./analytics"
import type { ChainStatus, Unit } from "./types"

const status: ChainStatus = {
  bestScore: { weightedCut: 3, countyFragments: 1, countySplits: 1, maxDeviationPpm: 50_000 },
  currentScore: { weightedCut: 4, countyFragments: 2, countySplits: 2, maxDeviationPpm: 50_000 },
  frontierSize: 2,
  stepsAccepted: 9,
  stepsRejected: 1,
}

describe("computeAnalytics", () => {
  it("derives detailed plan diagnostics without geometry", () => {
    const analytics = computeAnalytics(
      [
        unit("a", "001", 100, 60, 20, 10, 10, 60, 40),
        unit("b", "001", 110, 30, 50, 40, 10, 40, 60),
        unit("c", "003", 90, 70, 10, 5, 5, 45, 55),
        unit("d", "003", 100, 20, 55, 45, 10, 45, 55),
      ],
      { a: 1, b: 2, c: 1, d: 2 },
      2,
      status,
    )

    expect(analytics.totalPopulation).toBe(400)
    expect(analytics.maxDeviationPercent).toBeCloseTo(5)
    expect(analytics.counties.splitCount).toBe(2)
    expect(analytics.acceptanceRate).toBe(0.9)
    expect(analytics.weightedCut).toBe(4)
    expect(analytics.districts[1]?.demographicShares.black).toBeCloseTo(0.5)
    expect(analytics.election.demSeats).toBe(1)
    expect(analytics.election.competitiveDistricts).toBe(1)
  })
})

function unit(
  unitId: string,
  countyFips: string,
  popTotal: number,
  popWhite: number,
  popBlack: number,
  popHispanic: number,
  popAsian: number,
  dem: number,
  rep: number,
): Unit {
  return {
    unitId,
    countyFips,
    countyName: `County ${countyFips}`,
    label: unitId,
    popTotal,
    popWhite,
    popBlack,
    popHispanic,
    popAsian,
    popNative: 0,
    popPacific: 0,
    popOther: 0,
    president2024: { dem, rep, other: 0 },
  }
}
