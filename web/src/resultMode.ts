/**
 * Selects which completed ReCom output the standalone viewer presents. Inputs
 * are the neutral chain sample, recom-scoring's explicit Pareto selection, and
 * the shared chain status; outputs keep map, analytics, and exports consistent.
 */
import type { AssignmentMap, ChainStatus } from "./types"

export const resultModes = ["sample", "optimized"] as const
export type ResultMode = (typeof resultModes)[number]

export function resultModeFromQuery(value: string | null): ResultMode {
  return value === "optimized" ? "optimized" : "sample"
}

export function resultAssignment(
  mode: ResultMode,
  sample: AssignmentMap,
  optimized: AssignmentMap,
) {
  return mode === "optimized" ? optimized : sample
}

export function resultStatus(mode: ResultMode, status: ChainStatus): ChainStatus {
  return mode === "optimized"
    ? { ...status, currentScore: status.bestScore }
    : status
}
