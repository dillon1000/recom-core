/**
 * Defines the public viewer's data, graph, worker, and plan contracts. Inputs
 * are the published state manifests and wasm-bindgen API; outputs intentionally
 * avoid Resigned editor or save-schema types so this package runs standalone.
 */
export type StateEntry = {
  slug: string
  postal: string
  name: string
}

export type ViewerResolution = "block-group" | "precinct"

export type Unit = {
  unitId: string
  countyFips: string
  countyName: string
  label: string
  popTotal: number
  popWhite: number
  popBlack: number
  popHispanic: number
  popAsian: number
  popNative: number
  popPacific: number
  popOther: number
  president2024: {
    dem: number
    rep: number
    other: number
  }
}

export type UnitAdjacency = Record<string, string[]>
export type AssignmentMap = Record<string, number>

export type ManifestLayer = {
  sourceLayer: string
  promoteId?: string
  minzoom: number
  maxzoom: number
}

export type Manifest = {
  editUnit: "block-group" | "precinct"
  state: {
    slug: string
    postal: string
    stateName: string
    name: string
    districtCount: number
    bounds: [number, number, number, number]
  }
  counts: {
    units: number
    districts: number
    adjacencyEdges?: number
  }
  files: {
    unitStats: string
    unitAdjacency: string
    defaultAssignments: string
  }
  tiles: {
    pmtiles: {
      redistricting: string
      coarse?: { redistricting: string; layers: { units: ManifestLayer } }
      layers: { units: ManifestLayer }
    }
    reference?: {
      liveDistrictEdges?: ManifestLayer & { url: string }
    }
  }
}

export type StateBundle = {
  adjacency: UnitAdjacency
  initialAssignment?: Uint16Array
  manifest: Manifest
  units: Unit[]
  virtualEdges: number
}

export type PlanScore = { countySplits: number; cutEdges: number }

export type ChainStatus = {
  stepsAccepted: number
  stepsRejected: number
  currentScore: PlanScore
  bestScore: PlanScore
}

export type GraphInput = {
  edgeCountyCross: Uint8Array
  neighbors: Uint32Array
  offsets: Uint32Array
  populations: Uint32Array
  unitIds: string[]
}

export type GenerationParams = {
  districts: number
  seed: bigint
  popTolerance: number
  steps: number
  countySurcharge: number
  treeAttempts: number
  initialAssignment: Uint16Array
}

export type WorkerRequest = {
  type: "run"
  requestId: number
  graph: {
    edgeCountyCross: ArrayBuffer
    neighbors: ArrayBuffer
    offsets: ArrayBuffer
    populations: ArrayBuffer
  }
  params: Omit<GenerationParams, "initialAssignment"> & {
    initialAssignment?: ArrayBuffer
  }
}

export type WorkerResponse =
  | { type: "ready"; requestId: 0 }
  | { type: "progress"; requestId: number; completed: number; status: ChainStatus }
  | { type: "complete"; requestId: number; assignment: Uint16Array; status: ChainStatus }
  | { type: "error"; requestId: number; error: string }
