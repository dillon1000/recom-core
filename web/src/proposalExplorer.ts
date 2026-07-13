/**
 * Reconstructs individual ReCom proposals from chunk checkpoints and compact accepted deltas.
 * Inputs are one-based dense assignments plus worker trace chunks; outputs support random access,
 * filtering, comparison, playback, bookmarks, branching, and shareable proposal selection without
 * retaining one complete assignment per attempted step.
 */
import type { PlanScore, ProposalTrace, ProposalTraceChunk } from "./types"

export type ProposalFilters = {
  acceptedOnly: boolean
  frontierOnly: boolean
  maxCountyFragments: number | null
  maxDeviationPercent: number | null
  minDemSeats: number | null
  maxDemSeats: number | null
}

export type ProposalUnitVote = { dem: number; rep: number }

export type ProposalComparison = {
  changedUnits: number
  scoreDelta: PlanScore
}

export function proposalEvents(chunks: ProposalTraceChunk[]) {
  return chunks.flatMap((chunk) => chunk.proposals)
}

export function proposalEventsWithElections(
  initialAssignment: Uint16Array,
  chunks: ProposalTraceChunk[],
  unitVotes: ProposalUnitVote[],
  districtCount: number,
) {
  if (unitVotes.length !== initialAssignment.length) {
    throw new Error("Proposal election inputs must align with the dense assignment")
  }
  const assignment = initialAssignment.slice()
  const demVotes = new Float64Array(districtCount)
  const repVotes = new Float64Array(districtCount)
  for (let node = 0; node < assignment.length; node += 1) {
    const district = (assignment[node] ?? 1) - 1
    demVotes[district] += unitVotes[node]?.dem ?? 0
    repVotes[district] += unitVotes[node]?.rep ?? 0
  }
  const events: ProposalTrace[] = []
  for (const chunk of chunks) {
    for (const event of chunk.proposals) {
      const end = event.changeStart + event.changeCount
      for (let index = event.changeStart; index < end; index += 1) {
        const node = chunk.changedNodes[index]
        const next = chunk.changedDistricts[index]
        if (node === undefined || next === undefined) continue
        const previous = (assignment[node] ?? 1) - 1
        const nextIndex = next - 1
        const vote = unitVotes[node] ?? { dem: 0, rep: 0 }
        demVotes[previous] -= vote.dem
        repVotes[previous] -= vote.rep
        demVotes[nextIndex] += vote.dem
        repVotes[nextIndex] += vote.rep
        assignment[node] = next
      }
      let demSeats = 0
      for (let district = 0; district < districtCount; district += 1) {
        if (demVotes[district] > repVotes[district]) demSeats += 1
      }
      events.push({ ...event, demSeats, repSeats: districtCount - demSeats })
    }
  }
  return events
}

export function proposalAt(
  chunks: ProposalTraceChunk[],
  proposal: number,
): ProposalTrace | null {
  if (!Number.isInteger(proposal) || proposal < 1) return null
  for (const chunk of chunks) {
    const first = chunk.proposals[0]?.proposal
    const last = chunk.proposals.at(-1)?.proposal
    if (first !== undefined && last !== undefined && proposal >= first && proposal <= last) {
      return chunk.proposals.find((event) => event.proposal === proposal) ?? null
    }
  }
  return null
}

export function assignmentAtProposal(
  initialAssignment: Uint16Array,
  chunks: ProposalTraceChunk[],
  proposal: number,
) {
  const target = Math.max(0, Math.floor(proposal))
  let checkpoint = initialAssignment
  for (const chunk of chunks) {
    const last = chunk.proposals.at(-1)?.proposal ?? 0
    if (target >= last) {
      checkpoint = chunk.checkpoint
      continue
    }
    const assignment = checkpoint.slice()
    for (const event of chunk.proposals) {
      if (event.proposal > target) break
      applyEvent(assignment, chunk, event)
    }
    return assignment
  }
  return checkpoint.slice()
}

export function filterProposalEvents(
  events: ProposalTrace[],
  filters: ProposalFilters,
) {
  return events.filter((event) => {
    if (filters.acceptedOnly && event.outcome !== "accepted") return false
    if (filters.frontierOnly && !event.frontierRetained) return false
    if (
      filters.maxCountyFragments !== null
      && event.score.countyFragments > filters.maxCountyFragments
    ) return false
    if (
      filters.maxDeviationPercent !== null
      && event.score.maxDeviationPpm / 10_000 > filters.maxDeviationPercent
    ) return false
    if (filters.minDemSeats !== null && (event.demSeats ?? 0) < filters.minDemSeats) return false
    if (filters.maxDemSeats !== null && (event.demSeats ?? 0) > filters.maxDemSeats) return false
    return true
  })
}

export function compareProposals(
  leftAssignment: Uint16Array,
  leftScore: PlanScore,
  rightAssignment: Uint16Array,
  rightScore: PlanScore,
): ProposalComparison {
  if (leftAssignment.length !== rightAssignment.length) {
    throw new Error("Compared proposal assignments must have equal lengths")
  }
  let changedUnits = 0
  for (let index = 0; index < leftAssignment.length; index += 1) {
    if (leftAssignment[index] !== rightAssignment[index]) changedUnits += 1
  }
  return {
    changedUnits,
    scoreDelta: {
      weightedCut: rightScore.weightedCut - leftScore.weightedCut,
      countyFragments: rightScore.countyFragments - leftScore.countyFragments,
      countySplits: rightScore.countySplits - leftScore.countySplits,
      maxDeviationPpm: rightScore.maxDeviationPpm - leftScore.maxDeviationPpm,
    },
  }
}

export function nearestVisibleProposal(
  events: ProposalTrace[],
  current: number,
  direction: -1 | 1,
) {
  if (direction === 1) {
    for (const event of events) {
      if (event.proposal > current) return event.proposal
    }
  } else {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event && event.proposal < current) return event.proposal
    }
  }
  return current
}

function applyEvent(
  assignment: Uint16Array,
  chunk: ProposalTraceChunk,
  event: ProposalTrace,
) {
  const start = event.changeStart
  const end = start + event.changeCount
  for (let index = start; index < end; index += 1) {
    const node = chunk.changedNodes[index]
    const district = chunk.changedDistricts[index]
    if (node === undefined || district === undefined || node >= assignment.length) {
      throw new Error(`Proposal ${event.proposal} contains an invalid assignment delta`)
    }
    assignment[node] = district
  }
}
