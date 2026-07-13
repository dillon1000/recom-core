/**
 * Validates optional neutral-ensemble artifacts and interpolates metric percentiles. Inputs are the
 * static p1–p99 summaries named by a dataset manifest; outputs are bounded percentile ranks without
 * running sampling or adding request-path computation.
 */
import type { BaselineMetric, EnsembleBaseline } from "./types"

export function parseEnsembleBaseline(value: unknown): EnsembleBaseline {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.metrics)) {
    throw new Error("Ensemble baseline must contain meta and metrics objects.")
  }
  const meta = value.meta
  if (!Array.isArray(meta.seeds) || !meta.seeds.every(isNonnegativeInteger)
    || !isNonnegativeInteger(meta.steps) || !isFiniteNumber(meta.tolerance)
    || !isNonnegativeInteger(meta.burnIn) || !isNonnegativeInteger(meta.thinning)
    || typeof meta.coreVersion !== "string") {
    throw new Error("Ensemble baseline metadata is invalid.")
  }
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (!isBaselineMetric(metric)) throw new Error(`Ensemble baseline metric ${name} is invalid.`)
  }
  return value as EnsembleBaseline
}

export function percentileFor(
  baseline: EnsembleBaseline | undefined,
  metricName: string,
  value: number,
): number | null {
  if (!baseline || !Number.isFinite(value)) return null
  const metric = baseline.metrics[metricName]
  if (!metric || metric.count <= 0) return null
  const points = Object.entries(metric.percentiles)
    .map(([key, metricValue]) => {
      const match = /^p(\d+(?:\.\d+)?)$/.exec(key)
      return match ? [Number(match[1]), metricValue] as const : null
    })
    .filter((point): point is readonly [number, number] => point !== null
      && Number.isFinite(point[0]) && point[0] >= 0 && point[0] <= 100
      && Number.isFinite(point[1]))
    .sort((left, right) => left[0] - right[0])
  if (!points.length || points.some((point, index) => index > 0 && point[1] < (points[index - 1]?.[1] ?? point[1]))) {
    return null
  }
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return null
  if (value <= first[1]) return first[0]
  if (value >= last[1]) return last[0]
  for (let index = 1; index < points.length; index += 1) {
    const lower = points[index - 1]
    const upper = points[index]
    if (!lower || !upper || value > upper[1]) continue
    if (upper[1] === lower[1]) return (lower[0] + upper[0]) / 2
    const fraction = (value - lower[1]) / (upper[1] - lower[1])
    return lower[0] + fraction * (upper[0] - lower[0])
  }
  return null
}

function isBaselineMetric(value: unknown): value is BaselineMetric {
  return isRecord(value)
    && isNonnegativeInteger(value.count)
    && isFiniteNumber(value.mean)
    && isRecord(value.percentiles)
    && Object.values(value.percentiles).every(isFiniteNumber)
    && Array.isArray(value.histogram)
    && value.histogram.every((bin) => isRecord(bin)
      && isNonnegativeInteger(bin.min)
      && isNonnegativeInteger(bin.max)
      && isNonnegativeInteger(bin.count)
      && bin.min <= bin.max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
}
