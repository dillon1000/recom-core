import { describe, expect, it } from "vitest"

import {
  assignmentToDense,
  assignmentWithinTolerance,
  buildGraph,
  connectComponents,
} from "./graph"

describe("public viewer graph adapter", () => {
  it("links graph islands and disconnected starting districts deterministically", () => {
    const unitIds = ["1", "2", "3", "4", "5"]
    const assignment = assignmentToDense(unitIds, { "1": 1, "2": 2, "3": 1, "4": 2, "5": 2 })
    const connected = connectComponents(
      { "1": ["2"], "2": ["1", "3"], "3": ["2"], "4": ["5"], "5": ["4"] },
      unitIds,
      assignment,
    )

    expect(connected.virtualEdges).toBe(2)
    expect(connected.adjacency["1"]).toContain("3")
    expect(connected.adjacency["2"]).toContain("4")
    expect(connected.adjacency["4"]).toContain("5")
  })

  it("builds aligned CSR populations and county crossings", () => {
    const graph = buildGraph(
      { a: ["b"], b: ["a"] },
      [
        unit("a", "001", 10),
        unit("b", "003", 20),
      ],
    )
    expect([...graph.offsets]).toEqual([0, 1, 2])
    expect([...graph.neighbors]).toEqual([1, 0])
    expect([...graph.edgeCountyCross]).toEqual([1, 1])
    expect([...graph.populations]).toEqual([10, 20])
    expect(graph.edgeWeights).toBeUndefined()
  })

  it("builds symmetric directed weights aligned with neighbors", () => {
    const graph = buildGraph(
      { a: ["b", "c"], b: ["a"], c: ["a"] },
      [unit("a", "001", 10), unit("b", "001", 20), unit("c", "003", 30)],
      { a: [12, 34], b: [12], c: [34] },
    )
    expect([...graph.neighbors]).toEqual([1, 2, 0, 0])
    expect([...(graph.edgeWeights ?? [])]).toEqual([12, 34, 12, 34])
  })

  it("rejects misaligned or asymmetric weight artifacts", () => {
    const adjacency = { a: ["b"], b: ["a"] }
    const units = [unit("a", "001", 10), unit("b", "001", 20)]
    expect(() => buildGraph(adjacency, units, { a: [], b: [5] })).toThrow(/align/)
    expect(() => buildGraph(adjacency, units, { a: [5], b: [6] })).toThrow(/symmetric/)
  })

  it("assigns unit weight to deterministic virtual edges", () => {
    const unitIds = ["a", "b", "c"]
    const connected = connectComponents(
      { a: ["b"], b: ["a"], c: [] },
      unitIds,
      new Uint16Array([1, 1, 1]),
      { a: [50], b: [50], c: [] },
    )
    expect(connected.virtualEdges).toBe(1)
    const graph = buildGraph(
      connected.adjacency,
      unitIds.map((unitId) => unit(unitId, "001", 10)),
      connected.edgeWeights,
    )
    expect([...graph.edgeWeights ?? []].sort((a, b) => a - b)).toEqual([1, 1, 50, 50])
  })

  it("rejects a published assignment outside the requested tolerance", () => {
    const units = [
      unit("a", "001", 48), unit("b", "001", 52),
      unit("c", "003", 60), unit("d", "003", 40),
    ]
    expect(assignmentWithinTolerance(units, new Uint16Array([1, 1, 2, 2]), 2, 0.05)).toBe(true)
    expect(assignmentWithinTolerance(units, new Uint16Array([1, 2, 2, 2]), 2, 0.05)).toBe(false)
  })
})

function unit(unitId: string, countyFips: string, popTotal: number) {
  return {
    unitId,
    countyFips,
    countyName: "County",
    label: unitId,
    popTotal,
    popWhite: 0,
    popBlack: 0,
    popHispanic: 0,
    popAsian: 0,
    popNative: 0,
    popPacific: 0,
    popOther: 0,
    president2024: { dem: 0, rep: 0, other: 0 },
  }
}
