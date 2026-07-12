import { describe, expect, it } from "vitest"

import { assignmentToDense, buildGraph, connectComponents } from "./graph"

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
