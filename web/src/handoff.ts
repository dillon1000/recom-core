/**
 * Defines the public viewer's half of the Resigned2 browser bridge. Inputs are
 * nonce-bound postMessage envelopes and local plan/context payloads; outputs
 * are validated objects and target URLs. No assignment is uploaded or placed
 * in a URL, and changing the protocol requires a coordinated version bump.
 */
import { stateBySlug } from "./catalog"
import type { AssignmentMap, ViewerResolution } from "./types"

export const handoffChannel = "resigned2-recom-handoff"
export const handoffVersion = 1
export const resigned2BaseURL = "https://dillonr.ing/redistricting"

export type HandoffDirection = "recom-to-resigned2" | "resigned2-to-recom"
export type HandoffPhase = "ready" | "context" | "plan" | "complete" | "error"
export type HandoffAnimationPhase = "connecting" | "transferring" | "accepted" | "error"

export type Resigned2LaunchContext = {
  assignment?: AssignmentMap
  datasetSlug: string
  districtCount: number
  title?: string
  unitCount?: number
}

export type ReComPlanHandoff = {
  assignment: AssignmentMap
  datasetSlug: string
  districtCount: number
  generatedAt: string
  output: "sample" | "optimized" | "proposal"
  proposal: number | null
  seed: string
  unitCount: number
}

export function handoffTokenFromURL(url = location.href) {
  const token = new URL(url).searchParams.get("handoff")?.trim()
  return token && /^[a-z0-9-]{16,128}$/i.test(token) ? token : null
}

export function createHandoffToken() {
  return crypto.randomUUID()
}

export function handoffMessage(
  direction: HandoffDirection,
  phase: HandoffPhase,
  token: string,
  payload: Record<string, unknown> = {},
) {
  return {
    ...payload,
    channel: handoffChannel,
    direction,
    phase,
    token,
    version: handoffVersion,
  }
}

export function isHandoffMessage(
  value: unknown,
  direction: HandoffDirection,
  phase: HandoffPhase,
  token: string,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  return value.channel === handoffChannel
    && value.direction === direction
    && value.phase === phase
    && value.token === token
    && value.version === handoffVersion
}

export function parseLaunchContextMessage(
  value: unknown,
  token: string,
): Resigned2LaunchContext {
  if (!isHandoffMessage(value, "resigned2-to-recom", "context", token)) {
    throw new Error("The Resigned2 handoff message is invalid.")
  }
  const context = objectValue(value.context, "The Resigned2 map context is invalid.")
  const dataset = stringField(context, "datasetSlug")
  const districts = positiveIntegerField(context, "districtCount")
  const title = optionalStringField(context, "title")
  const assignment = context.assignment === undefined
    ? undefined
    : assignmentField(context.assignment, districts)
  const unitCount = context.unitCount === undefined
    ? undefined
    : positiveIntegerField(context, "unitCount")
  if (assignment && unitCount !== Object.keys(assignment).length) {
    throw new Error("The Resigned2 map does not contain its declared number of units.")
  }
  return {
    ...(assignment ? { assignment } : {}),
    datasetSlug: dataset,
    districtCount: districts,
    ...(title ? { title } : {}),
    ...(unitCount ? { unitCount } : {}),
  }
}

export function datasetSelection(dataset: string): {
  resolution: ViewerResolution
  stateSlug: string
} {
  const precinctSuffix = "-precincts"
  const resolution: ViewerResolution = dataset.endsWith(precinctSuffix)
    ? "precinct"
    : "block-group"
  const stateSlug = resolution === "precinct"
    ? dataset.slice(0, -precinctSuffix.length)
    : dataset
  if (!stateBySlug.has(stateSlug)) {
    throw new Error("This Resigned2 dataset is unavailable in the public ReCom viewer.")
  }
  return { resolution, stateSlug }
}

export function resigned2HandoffURL(token: string, baseURL = resigned2BaseURL) {
  const url = new URL(`${baseURL.replace(/\/$/, "")}/v1/handoff/recom`)
  url.searchParams.set("token", token)
  return url.toString()
}

export function resigned2Origin(baseURL = resigned2BaseURL) {
  return new URL(baseURL).origin
}

function assignmentField(value: unknown, districtCount: number): AssignmentMap {
  const source = objectValue(value, "The Resigned2 assignment is invalid.")
  return Object.fromEntries(Object.entries(source).map(([unitID, district]) => {
    if (!unitID.trim() || !Number.isInteger(district) || Number(district) < 1 || Number(district) > districtCount) {
      throw new Error(`The Resigned2 assignment for ${unitID || "an unknown unit"} is invalid.`)
    }
    return [unitID, Number(district)]
  }))
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(message)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Resigned2 is missing ${key}.`)
  return value.trim()
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveIntegerField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Resigned2 ${key} is invalid.`)
  return Number(value)
}
