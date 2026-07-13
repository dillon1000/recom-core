/**
 * Verifies random-access proposal reconstruction, filtering, comparison, and navigation.
 */
import { describe, expect, it } from "vitest"

import {
  assignmentAtProposal,
  compareProposals,
  filterProposalEvents,
  nearestVisibleProposal,
  proposalAt,
  proposalEvents,
  proposalEventsWithElections,
} from "./proposalExplorer"
import type { ProposalTraceChunk } from "./types"

const score = (weightedCut: number, countyFragments: number, maxDeviationPpm: number) => ({
  weightedCut,
  countyFragments,
  countySplits: countyFragments > 0 ? 1 : 0,
  maxDeviationPpm,
})

const chunks: ProposalTraceChunk[] = [
  {
    proposals: [
      {
        proposal: 1,
        outcome: "accepted",
        score: score(8, 3, 20_000),
        changeStart: 0,
        changeCount: 1,
        frontierChanged: true,
        frontierRetained: true,
      },
      {
        proposal: 2,
        outcome: "noBalancedCut",
        score: score(8, 3, 20_000),
        changeStart: 1,
        changeCount: 0,
        frontierChanged: false,
      },
    ],
    changedNodes: new Uint32Array([1]),
    changedDistricts: new Uint16Array([2]),
    checkpoint: new Uint16Array([1, 2, 2, 2]),
  },
  {
    proposals: [
      {
        proposal: 3,
        outcome: "burstRestart",
        score: score(8, 3, 20_000),
        changeStart: 0,
        changeCount: 1,
        frontierChanged: false,
      },
      {
        proposal: 4,
        outcome: "accepted",
        score: score(7, 1, 30_000),
        changeStart: 1,
        changeCount: 2,
        frontierChanged: true,
        frontierRetained: true,
      },
    ],
    changedNodes: new Uint32Array([1, 0, 3]),
    changedDistricts: new Uint16Array([1, 2, 1]),
    checkpoint: new Uint16Array([2, 1, 2, 1]),
  },
]

describe("proposal explorer", () => {
  it("reconstructs accepted and rejected proposal states from checkpoints", () => {
    const initial = new Uint16Array([1, 1, 2, 2])
    expect([...assignmentAtProposal(initial, chunks, 0)]).toEqual([1, 1, 2, 2])
    expect([...assignmentAtProposal(initial, chunks, 1)]).toEqual([1, 2, 2, 2])
    expect([...assignmentAtProposal(initial, chunks, 2)]).toEqual([1, 2, 2, 2])
    expect([...assignmentAtProposal(initial, chunks, 3)]).toEqual([1, 1, 2, 2])
    expect([...assignmentAtProposal(initial, chunks, 4)]).toEqual([2, 1, 2, 1])
  })

  it("indexes, filters, and navigates proposal metadata", () => {
    const events = proposalEvents(chunks)
    expect(proposalAt(chunks, 2)?.outcome).toBe("noBalancedCut")
    expect(proposalAt(chunks, 3)?.outcome).toBe("burstRestart")
    expect(filterProposalEvents(events, {
      acceptedOnly: true,
      frontierOnly: true,
      maxCountyFragments: 2,
      maxDeviationPercent: 3,
      minDemSeats: null,
      maxDemSeats: null,
    }).map((event) => event.proposal)).toEqual([4])
    expect(nearestVisibleProposal(events, 1, 1)).toBe(2)
    expect(nearestVisibleProposal(events, 3, -1)).toBe(2)
  })

  it("updates district election outcomes incrementally from proposal deltas", () => {
    const events = proposalEventsWithElections(
      new Uint16Array([1, 1, 2, 2]),
      chunks,
      [
        { dem: 100, rep: 0 },
        { dem: 100, rep: 0 },
        { dem: 0, rep: 300 },
        { dem: 0, rep: 100 },
      ],
      2,
    )
    expect(events[0]?.demSeats).toBe(1)
    expect(events.at(-1)?.demSeats).toBe(0)
    expect(events.at(-1)?.repSeats).toBe(2)
  })

  it("reports assignment and score deltas between pinned proposals", () => {
    const comparison = compareProposals(
      new Uint16Array([1, 2, 2, 2]),
      score(8, 3, 20_000),
      new Uint16Array([2, 2, 2, 1]),
      score(7, 1, 30_000),
    )
    expect(comparison.changedUnits).toBe(2)
    expect(comparison.scoreDelta).toEqual({
      weightedCut: -1,
      countyFragments: -2,
      countySplits: 0,
      maxDeviationPpm: 10_000,
    })
  })
})
