/**
 * Exercises the generated WASM package as the standalone worker does. The fixtures verify default
 * and nonuniform weights, nondominated frontier serialization, one-based indexed assignments, and
 * compatibility best-plan selection without relying on the browser UI.
 */
import { readFileSync } from "node:fs"

import { beforeAll, describe, expect, it } from "vitest"

import initializeWasm, { Chain } from "./wasm/recom_core"
import type { ChainStatus, PlanScore, ProposalTraceBatch } from "./types"

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

  it("rejects county preservation outside the public 0–50 range", () => {
    expect(() => createChain(null, 51)).toThrow(/between 0 and 50/)
  })

  it("emits one-based compact deltas that reconstruct the final assignment", () => {
    const chain = createChain(null)
    const reconstructed = chain.assignment()
    const batch = chain.step_traced(40) as ProposalTraceBatch
    for (const proposal of batch.proposals) {
      for (
        let index = proposal.changeStart;
        index < proposal.changeStart + proposal.changeCount;
        index += 1
      ) {
        const node = batch.changedNodes[index]
        const district = batch.changedDistricts[index]
        if (node !== undefined && district !== undefined) reconstructed[node] = district
      }
    }
    expect(batch.proposals).toHaveLength(40)
    expect(batch.changedNodes).toHaveLength(batch.changedDistricts.length)
    expect([...reconstructed]).toEqual([...chain.assignment()])
    expect(batch.changedDistricts.every((district) => district === 1 || district === 2)).toBe(true)
    chain.free()
  })

  it("serializes burst restarts with monotonic event numbers", () => {
    const chain = createBurstChain()
    const batch = chain.step_traced(40) as ProposalTraceBatch
    const restarts = batch.proposals.filter((proposal) => proposal.outcome === "burstRestart")
    expect(restarts.length).toBeGreaterThan(0)
    expect(batch.status.burstRestarts).toBe(restarts.length)
    expect(batch.proposals.map((proposal) => proposal.proposal)).toEqual(
      batch.proposals.map((_, index) => index + 1),
    )
    chain.free()
  })

  it("runs reversible proposals with explicit self-loop outcomes", () => {
    const width = 4
    const height = 8
    const graph = gridGraph(width, height)
    const initialAssignment = Uint16Array.from(
      { length: width * height },
      (_, node) => Math.floor(node / (width * 2)) + 1,
    )
    const chain = new Chain(
      graph.offsets,
      graph.neighbors,
      new Uint8Array(graph.neighbors.length),
      null,
      new Uint32Array(width * height).fill(1),
      {
        districts: 4,
        seed: 0x5eed_2026n,
        popTolerance: 0.25,
        countySurcharge: 0,
        treeAttempts: 1,
        burstLength: 0,
        variant: "reversible",
        balanceUb: 1,
        frozenDistricts: new Uint16Array(),
        initialAssignment,
      },
    )

    const batch = chain.step_traced(5_000) as ProposalTraceBatch
    const outcomes = new Set(batch.proposals.map((proposal) => proposal.outcome))
    expect(outcomes).toContain("nonAdjacentPair")
    expect(outcomes).toContain("balanceBoundExceeded")
    expect(outcomes).toContain("seamRejected")
    expect(outcomes).toContain("accepted")
    expectGridAssignmentValid(chain.assignment(), graph, 4, 0.25)
    chain.free()
  })
})

function gridGraph(width: number, height: number) {
  const rows = Array.from({ length: width * height }, () => [] as number[])
  const connect = (a: number, b: number) => {
    rows[a]?.push(b)
    rows[b]?.push(a)
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const node = y * width + x
      if (x + 1 < width) connect(node, node + 1)
      if (y + 1 < height) connect(node, node + width)
    }
  }
  const offsets = [0]
  const neighbors: number[] = []
  for (const row of rows) {
    row.sort((a, b) => a - b)
    neighbors.push(...row)
    offsets.push(neighbors.length)
  }
  return {
    offsets: Uint32Array.from(offsets),
    neighbors: Uint32Array.from(neighbors),
    rows,
  }
}

function expectGridAssignmentValid(
  assignment: Uint16Array,
  graph: ReturnType<typeof gridGraph>,
  districts: number,
  tolerance: number,
) {
  const ideal = assignment.length / districts
  for (let district = 1; district <= districts; district += 1) {
    const nodes = [...assignment]
      .map((label, node) => ({ label, node }))
      .filter(({ label }) => label === district)
      .map(({ node }) => node)
    expect(nodes.length).toBeGreaterThanOrEqual(ideal * (1 - tolerance))
    expect(nodes.length).toBeLessThanOrEqual(ideal * (1 + tolerance))
    const remaining = new Set(nodes)
    const stack = [nodes[0] ?? -1]
    remaining.delete(stack[0] ?? -1)
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) continue
      for (const neighbor of graph.rows[node] ?? []) {
        if (remaining.delete(neighbor)) stack.push(neighbor)
      }
    }
    expect(remaining.size).toBe(0)
  }
}

function createBurstChain() {
  return new Chain(
    new Uint32Array([0, 2, 5, 7, 9, 12, 14]),
    new Uint32Array([1, 3, 0, 2, 4, 1, 5, 0, 4, 1, 3, 5, 2, 4]),
    new Uint8Array(14),
    null,
    new Uint32Array(6).fill(1),
    {
      districts: 2,
      seed: 1n,
      popTolerance: 0.01,
      countySurcharge: 0,
      treeAttempts: 8,
      burstLength: 2,
      frozenDistricts: new Uint16Array(),
      initialAssignment: new Uint16Array([1, 1, 1, 2, 2, 2]),
    },
  )
}

function createChain(edgeWeights: Uint32Array | null, countySurcharge = 0, burstLength?: number) {
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
      countySurcharge,
      treeAttempts: 8,
      ...(burstLength === undefined ? {} : { burstLength }),
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
