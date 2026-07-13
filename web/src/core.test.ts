/**
 * Exercises the generated WASM package as the standalone worker does. The fixtures verify default
 * and nonuniform weights, nondominated frontier serialization, one-based indexed assignments, and
 * compatibility best-plan selection without relying on the browser UI.
 */
import { readFileSync } from "node:fs"

import { beforeAll, describe, expect, it } from "vitest"

import initializeWasm, { Chain } from "./wasm/recom_core"
import type { ChainStatus, PlanScore } from "./types"

beforeAll(async () => {
  await initializeWasm({
    module_or_path: readFileSync(new URL("./wasm/recom_core_bg.wasm", import.meta.url)),
  })
})

describe("recom-core WASM scoring contract", () => {
  it("defaults weighted cut to the canonical cut-edge count", () => {
    const chain = createChain(null)
    const status = chain.step(0) as ChainStatus
    expect(status.currentScore).toMatchObject({
      weightedCut: 1,
      countyFragments: 1,
      countySplits: 1,
      maxDeviationPpm: 0,
    })
    chain.free()
  })

  it("uses nonuniform weights without changing assignment validity", () => {
    const chain = createChain(new Uint32Array([2, 2, 7, 7, 11, 11]))
    const status = chain.step(0) as ChainStatus
    expect(status.currentScore.weightedCut).toBe(7)
    expect([...chain.assignment()]).toEqual([1, 1, 2, 2])
    chain.free()
  })

  it("round-trips deterministic frontier assignments and best selection", () => {
    const chain = createChain(null)
    chain.step(200)
    const frontier = chain.frontier() as PlanScore[]
    expect(frontier.length).toBeGreaterThan(0)
    expect(frontier.length).toBeLessThanOrEqual(24)
    for (let index = 0; index < frontier.length; index += 1) {
      const assignment = chain.frontier_assignment(index)
      expect(assignment).toHaveLength(4)
      expect([...assignment].every((district) => district === 1 || district === 2)).toBe(true)
      for (const other of frontier.slice(index + 1)) {
        expect(dominates(frontier[index], other)).toBe(false)
        expect(dominates(other, frontier[index])).toBe(false)
      }
    }
    expect([...chain.best_assignment()]).toEqual([...chain.frontier_assignment(0)])
    chain.free()
  })
})

function createChain(edgeWeights: Uint32Array | null) {
  return new Chain(
    new Uint32Array([0, 1, 3, 5, 6]),
    new Uint32Array([1, 0, 2, 1, 3, 2]),
    new Uint8Array([0, 0, 0, 0, 0, 0]),
    edgeWeights,
    new Uint32Array([1, 1, 1, 1]),
    {
      districts: 2,
      seed: 42n,
      popTolerance: 0.01,
      countySurcharge: 0,
      treeAttempts: 8,
      frozenDistricts: new Uint16Array(),
      initialAssignment: new Uint16Array([1, 1, 2, 2]),
    },
  )
}

function dominates(left: PlanScore | undefined, right: PlanScore | undefined) {
  if (!left || !right) return false
  return left.weightedCut <= right.weightedCut
    && left.countyFragments <= right.countyFragments
    && left.maxDeviationPpm <= right.maxDeviationPpm
    && (left.weightedCut < right.weightedCut
      || left.countyFragments < right.countyFragments
      || left.maxDeviationPpm < right.maxDeviationPpm)
}
