/**
 * Downloads and parses public state artifacts off the UI thread. Inputs are a
 * dataset slug and configurable data origin; outputs are a validated manifest,
 * compact unit records, a contiguous starting assignment, and transfer-ready
 * CSR graph arrays. Failures return descriptive messages without partial data.
 */
import { assignmentToDense, buildGraph, connectComponents } from "./graph"
import type { AssignmentMap, Manifest, Unit, UnitAdjacency } from "./types"
import { parseUnits } from "./unitParser"

type Request = { type: "load"; requestId: number; slug: string; dataOrigin: string }
type WorkerResponse =
  | { type: "progress"; requestId: number; phase: string }
  | {
      type: "complete"
      requestId: number
      manifest: Manifest
      units: Unit[]
      initialAssignment: Uint16Array
      virtualEdges: number
      graph: ReturnType<typeof buildGraph>
    }
  | { type: "error"; requestId: number; error: string }

self.addEventListener("message", (event: MessageEvent<Request>) => {
  if (event.data.type === "load") void load(event.data)
})

async function load(message: Request) {
  try {
    post({ type: "progress", requestId: message.requestId, phase: "Loading manifest" })
    const manifest = await fetchJson<Manifest>(
      `${message.dataOrigin}/api/states/${message.slug}/manifest.json`,
    )
    validateManifest(manifest, message.slug)
    post({ type: "progress", requestId: message.requestId, phase: "Downloading state graph" })

    const statisticsUrl = assetUrl(message.dataOrigin, message.slug, manifest.files.unitStats)
    const [statistics, adjacency, defaults] = await Promise.all([
      fetch(statisticsUrl).then(requireOk),
      fetchJson<UnitAdjacency>(assetUrl(message.dataOrigin, message.slug, manifest.files.unitAdjacency)),
      fetchJson<{ assignments?: AssignmentMap }>(
        assetUrl(message.dataOrigin, message.slug, manifest.files.defaultAssignments),
      ),
    ])
    post({ type: "progress", requestId: message.requestId, phase: "Parsing state units" })
    const units = await parseUnits(await statistics.arrayBuffer(), statisticsUrl)
    if (units.length !== manifest.counts.units) {
      throw new Error(`Expected ${manifest.counts.units} units but loaded ${units.length}.`)
    }
    if (!defaults.assignments) throw new Error("The starting assignment is missing.")
    const unitIds = units.map((unit) => unit.unitId)
    const initialAssignment = assignmentToDense(unitIds, defaults.assignments)
    const connected = connectComponents(adjacency, unitIds, initialAssignment)
    const graph = buildGraph(connected.adjacency, units)
    const response: WorkerResponse = {
      type: "complete",
      requestId: message.requestId,
      manifest,
      units,
      initialAssignment,
      virtualEdges: connected.virtualEdges,
      graph,
    }
    self.postMessage(response, {
      transfer: [
        initialAssignment.buffer,
        graph.edgeCountyCross.buffer,
        graph.neighbors.buffer,
        graph.offsets.buffer,
        graph.populations.buffer,
      ],
    })
  } catch (error) {
    post({
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function validateManifest(manifest: Manifest, slug: string) {
  if (manifest.state?.slug !== slug) throw new Error(`Manifest belongs to ${manifest.state?.slug}.`)
  if (!manifest.files?.unitStats || !manifest.files.unitAdjacency || !manifest.files.defaultAssignments) {
    throw new Error("Manifest is missing ReCom input files.")
  }
  if (!manifest.tiles?.pmtiles?.redistricting) throw new Error("Manifest is missing map PMTiles.")
}

function assetUrl(origin: string, slug: string, rawUrl: string) {
  const source = new URL(rawUrl, origin)
  const file = source.pathname.split("/").at(-1)
  if (!file || !/^[a-z0-9][a-z0-9._-]*$/i.test(file)) throw new Error(`Invalid asset URL: ${rawUrl}`)
  return `${origin}/api/states/${slug}/${file}`
}

async function fetchJson<T>(url: string) {
  const response = requireOk(await fetch(url, { headers: { accept: "application/json" } }))
  return await response.json() as T
}

function requireOk(response: globalThis.Response) {
  if (!response.ok) throw new Error(`${new URL(response.url).pathname} returned ${response.status}.`)
  return response
}

function post(message: WorkerResponse) {
  self.postMessage(message)
}

export {}
