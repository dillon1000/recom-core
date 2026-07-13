/**
 * Owns the standalone public viewer UI. Inputs are URL-backed controls and the
 * 50-state data loader; outputs are deterministic plans, live map updates,
 * shareable proposal URLs, map-linked chain exploration, portable JSON
 * assignments, and nonce-bound Resigned2 tab handoffs. Generation and map
 * transfer are local and unsigned with no server compute path.
 */
import "./style.css"

import { computeAnalytics, demographicKeys, type PlanAnalytics } from "./analytics"
import {
  datasetSlug,
  resolutionFromQuery,
  resolutionLabel,
  states,
  stateBySlug,
  viewerResolutions,
} from "./catalog"
import { loadState, type LoadedState } from "./data"
import { assignmentToDense, assignmentWithinTolerance, denseToAssignment } from "./graph"
import {
  createHandoffToken,
  datasetSelection,
  handoffMessage,
  handoffTokenFromURL,
  isHandoffMessage,
  parseLaunchContextMessage,
  resigned2HandoffURL,
  resigned2Origin,
  type HandoffAnimationPhase,
  type HandoffDirection,
  type ReComPlanHandoff,
  type Resigned2LaunchContext,
} from "./handoff"
import { ViewerMap } from "./map"
import type { MapColorMode } from "./mapColors"
import { ProposalPanel } from "./proposalPanel"
import ReComWorker from "./recom.worker?worker"
import {
  resultAssignment,
  resultModeFromQuery,
  resultStatus,
  type ResultMode,
} from "./resultMode"
import type {
  AssignmentMap,
  ChainStatus,
  PlanScore,
  ProposalTraceChunk,
  ViewerResolution,
  WorkerRequest,
  WorkerResponse,
} from "./types"

const app = document.querySelector<HTMLElement>("#app")
if (!app) throw new Error("The viewer root is missing.")

const icons = {
  chart: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`,
  dices: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/></svg>`,
  download: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
  handoff: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
}

app.innerHTML = `
  <div class="viewer-shell">
    <section class="viewer-map" aria-label="Generated district map">
      <div id="map" class="viewer-map__canvas"></div>
      <div class="map-overlays">
        <div class="map-label"><strong id="map-state">Loading</strong><span id="map-status">Authentic geography</span></div>
        <div class="map-color-control">
          <span>Map color</span>
          <div role="group" aria-label="Map color mode"><button type="button" data-map-color="district" aria-pressed="true">Districts</button><button type="button" data-map-color="partisanship" aria-pressed="false" disabled>Partisan</button></div>
          <div class="partisan-legend" id="partisan-legend" role="img" aria-label="Each generated district colored continuously by its aggregate 2024 presidential two-party margin from Republican plus 30 through even to Democratic plus 30" hidden><i></i><div><span>R +30</span><span>Even</span><span>D +30</span></div></div>
        </div>
        <div class="map-hover" id="map-hover" hidden></div>
      </div>
    </section>

    <aside class="viewer-panel">
      <header class="panel-header">
        <div class="panel-identity">
          <span class="viewer-mark">AR</span>
          <div><h1>Auto-redistricter</h1><span class="viewer-eyebrow">recom-core / public viewer</span></div>
        </div>
        <p>Contiguous, population-balanced congressional plans from census block groups or authentic precincts. Deterministic, local, and unsigned—no account, upload, or server compute.</p>
      </header>

      <section class="panel-section" aria-labelledby="dataset-heading">
        <div class="section-heading"><span>01</span><h2 id="dataset-heading">Dataset</h2></div>
        <fieldset class="resolution-control">
          <legend>Geography</legend>
          <div>${viewerResolutions.map((resolution) => `<button type="button" data-resolution="${resolution}" aria-pressed="false">${resolution === "precinct" ? "Precincts" : "Block groups"}</button>`).join("")}</div>
          <small id="resolution-help"></small>
        </fieldset>
        <label class="field"><span>State</span><select id="state-select"></select></label>
        <div class="metric-grid metric-grid--three">
          <div class="metric"><span id="units-label">Block groups</span><strong id="units-value">—</strong></div>
          <div class="metric"><span>Districts</span><strong id="districts-value">—</strong></div>
          <div class="metric"><span>Adj. edges</span><strong id="edges-value">—</strong></div>
        </div>
        <div class="load-state" id="load-state" role="status"><span class="progress"><i></i></span><span id="load-label">Loading state data</span></div>
        <p class="note" id="island-note" hidden></p>
      </section>

      <section class="panel-section" aria-labelledby="parameters-heading">
        <div class="section-heading"><span>02</span><h2 id="parameters-heading">Parameters</h2></div>
        <label class="field"><span>Seed</span><div class="input-action"><input id="seed" inputmode="numeric" /><button id="random-seed" type="button" aria-label="Generate a random seed">${icons.dices}</button></div><small>Same state, seed, and controls produce the same plan.</small></label>
        <div class="control-grid">
          <label class="field"><span>Proposals</span><input id="steps" type="number" min="0" max="100000" step="100" /></label>
          <label class="field"><span>Tree attempts</span><input id="attempts" type="number" min="1" max="20" /></label>
          <label class="field" title="Attempted proposals per neutral burst; 0 disables bursts."><span>Burst length</span><input id="burst" type="number" min="0" max="10000" step="5" title="0 disables bursts." /></label>
        </div>
        <label class="range-field"><span><span>Population tolerance</span><output id="tolerance-output">5.0%</output></span><input id="tolerance" type="range" min="0.5" max="15" step="0.5" /></label>
        <label class="range-field"><span><span>County preservation</span><output id="county-output">10</output></span><input id="county" type="range" min="0" max="50" step="1" /><small>Biases proposals toward county boundaries and weights county fragments when Optimize selects a plan.</small></label>
      </section>

      <section class="panel-section" aria-labelledby="generation-heading">
        <div class="section-heading"><span>03</span><h2 id="generation-heading">Generation</h2></div>
        <div class="actions"><button class="button button--primary" id="generate" type="button" disabled>Generate plan</button><button class="button" id="copy" type="button" disabled>Copy setup</button></div>
        <p class="note" id="generation-note">ReCom starts from the published reference assignment, then advances the seeded proposal chain entirely inside a Web Worker.</p>
        <p class="error" id="error" role="alert" hidden></p>
      </section>

      <section class="panel-section" id="result-section" aria-labelledby="result-heading" hidden>
        <div class="section-heading"><span>04</span><h2 id="result-heading">Result</h2></div>
        <fieldset class="result-mode-control">
          <legend>Plan output</legend>
          <div role="group" aria-label="Generated plan output"><button type="button" data-result-mode="sample" aria-pressed="true">Sample</button><button type="button" data-result-mode="optimized" aria-pressed="false">Optimize</button></div>
          <small id="result-mode-help">Sample preserves the final neutral chain state.</small>
        </fieldset>
        <div class="metric-grid metric-grid--two">
          <div class="metric"><span>Population</span><strong id="population-value">—</strong></div>
          <div class="metric"><span>Ideal / district</span><strong id="ideal-value">—</strong></div>
          <div class="metric"><span>Max deviation</span><strong id="deviation-value">—</strong></div>
          <div class="metric"><span>Seed</span><strong id="result-seed">—</strong></div>
        </div>
        <button class="button button--full button--primary" id="send-resigned2" type="button">${icons.handoff}Open in Resigned2</button>
        <button class="button button--full" id="download" type="button">${icons.download}Download assignment JSON</button>
        <button class="button button--full button--analytics" id="open-analytics" type="button">${icons.chart}Open detailed analytics</button>
        <button class="button button--full button--explorer" id="open-explorer" type="button" hidden>${icons.chart}Explore proposals</button>
      </section>

      <footer class="panel-footer"><span>MIT / DETERMINISTIC WASM</span><a href="https://github.com/dillon1000/recom-core">Source</a></footer>
    </aside>

    <footer class="telemetry" id="telemetry" data-state="loading" role="status" aria-live="polite">
      <div class="telemetry-state"><i></i><b id="run-label">Loading data</b></div>
      <div class="telemetry-progress"><span class="progress"><i id="run-progress"></i></span><b id="run-percent">0%</b></div>
      <div class="telemetry-metrics" id="score-grid" hidden>
        <div><span>Accepted</span><strong id="accepted-value">0</strong></div>
        <div><span>Rejected</span><strong id="rejected-value">0</strong></div>
        <div><span>Weighted cut</span><strong id="cut-value">0</strong></div>
        <div><span>County splits</span><strong id="splits-value">0</strong></div>
      </div>
    </footer>

    <aside class="handoff-dialog" id="handoff-dialog" role="dialog" aria-labelledby="handoff-title" aria-describedby="handoff-detail" hidden>
      <div class="handoff-dialog__eyebrow">LOCAL MAP BRIDGE</div>
      <h2 id="handoff-title">Connecting Resigned2 and ReCom</h2>
      <p id="handoff-detail">Waiting for the other tab to confirm the private connection.</p>
      <div class="handoff-visual" id="handoff-visual" data-direction="resigned2-to-recom" data-phase="connecting" role="img" aria-label="Connecting Resigned2 and ReCom">
        <span class="handoff-endpoint" data-endpoint="resigned2"><i></i><b>R2</b></span>
        <span class="handoff-track"><i></i><b id="handoff-packet"></b></span>
        <span class="handoff-endpoint" data-endpoint="recom"><i></i><b>ReCom</b></span>
      </div>
      <button class="button" id="handoff-close" type="button" hidden>Close</button>
    </aside>

    <aside class="analytics-panel" id="analytics-panel" role="dialog" aria-label="Generated plan analytics" hidden>
      <header class="analytics-header"><div><span>PLAN OBSERVATORY</span><h2>Generated plan analytics</h2><p id="analytics-subtitle"></p></div><button id="close-analytics" type="button" aria-label="Close analytics">${icons.x}</button></header>
      <nav class="analytics-tabs" id="analytics-tabs" aria-label="Analytics views">
        <button data-tab="overview" aria-current="page">Overview</button><button data-tab="population">Population</button><button data-tab="demographics">Demographics</button><button data-tab="elections">Elections</button><button data-tab="districts">Districts</button>
      </nav>
      <div class="analytics-body" id="analytics-body"></div>
    </aside>
  </div>
`

const elements = {
  accepted: get("accepted-value"), attempts: input("attempts"), burst: input("burst"), copy: button("copy"),
  analyticsBody: get("analytics-body"), analyticsPanel: get("analytics-panel"),
  analyticsSubtitle: get("analytics-subtitle"), analyticsTabs: get("analytics-tabs"),
  closeAnalytics: button("close-analytics"),
  county: input("county"), countyOutput: get("county-output"), cut: get("cut-value"),
  deviation: get("deviation-value"), districts: get("districts-value"), download: button("download"),
  edges: get("edges-value"), error: get("error"), generate: button("generate"),
  generationNote: get("generation-note"), ideal: get("ideal-value"), islandNote: get("island-note"),
  loadLabel: get("load-label"), loadState: get("load-state"), map: get("map"),
  mapHover: get("map-hover"),
  mapColorButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-map-color]")),
  mapState: get("map-state"), mapStatus: get("map-status"), population: get("population-value"),
  randomSeed: button("random-seed"), rejected: get("rejected-value"), resultSection: get("result-section"),
  openAnalytics: button("open-analytics"),
  openExplorer: button("open-explorer"),
  partisanLegend: get("partisan-legend"),
  resolutionButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-resolution]")),
  resolutionHelp: get("resolution-help"),
  resultModeButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-result-mode]")),
  resultModeHelp: get("result-mode-help"),
  resultSeed: get("result-seed"), runLabel: get("run-label"), runPercent: get("run-percent"),
  runProgress: get("run-progress"), scoreGrid: get("score-grid"), seed: input("seed"),
  splits: get("splits-value"), state: select("state-select"), steps: input("steps"),
  telemetry: get("telemetry"),
  tolerance: input("tolerance"), toleranceOutput: get("tolerance-output"), units: get("units-value"),
  unitsLabel: get("units-label"),
  sendResigned2: button("send-resigned2"),
  handoffClose: button("handoff-close"), handoffDetail: get("handoff-detail"),
  handoffDialog: get("handoff-dialog"), handoffPacket: get("handoff-packet"),
  handoffTitle: get("handoff-title"), handoffVisual: get("handoff-visual"),
}

for (const state of states) {
  const option = document.createElement("option")
  option.value = state.slug
  option.textContent = `${state.name} · ${state.postal}`
  elements.state.append(option)
}

const setup = readSetup()
elements.state.value = setup.state
activateResolution(setup.resolution)
elements.seed.value = setup.seed
elements.steps.value = String(setup.steps)
elements.attempts.value = String(setup.attempts)
elements.burst.value = String(setup.burst)
elements.tolerance.value = String(setup.tolerance)
elements.county.value = String(setup.county)
syncRangeLabels()

let loaded: LoadedState | null = null
let viewerMap: ViewerMap | null = null
let recomWorker: Worker | null = null
let assignment: AssignmentMap | null = null
let sampleAssignment: AssignmentMap | null = null
let bestAssignment: AssignmentMap | null = null
let frontierScores: PlanScore[] = []
let proposalTrace: ProposalTraceChunk[] = []
let proposalInitialAssignment: Uint16Array | null = null
let proposalInitialScore: PlanScore | null = null
let proposalScoreOverride: PlanScore | null = null
let selectedProposal: number | null = null
let lastStatus: ChainStatus | null = null
let analytics: PlanAnalytics | null = null
let handoffInitialAssignment: Uint16Array | null = null
let handoffCleanup = () => {}
let unitLookup = new Map<string, LoadedState["units"][number]>()
let requestId = 0

const proposalPanel = new ProposalPanel({
  onSelect: (denseAssignment, score, proposal) => {
    if (!loaded || !lastStatus) return
    assignment = denseToAssignment(loaded.graph.unitIds, denseAssignment)
    proposalScoreOverride = score
    selectedProposal = proposal
    finishPlan(BigInt(elements.seed.value), false)
  },
  onCompare: (denseAssignment) => {
    viewerMap?.setComparison(
      loaded && denseAssignment
        ? denseToAssignment(loaded.graph.unitIds, denseAssignment)
        : null,
    )
  },
  onBranch: (denseAssignment, proposal) => {
    void generate(denseAssignment, proposal)
  },
})

activateResultMode(setup.resultMode)

elements.state.addEventListener("change", () => void loadSelectedState())
for (const control of elements.resultModeButtons) {
  control.addEventListener("click", () => {
    proposalPanel.close()
    proposalScoreOverride = null
    selectedProposal = null
    updateProposalUrl(null)
    activateResultMode(control.dataset.resultMode === "optimized" ? "optimized" : "sample")
  })
}
for (const control of elements.mapColorButtons) {
  control.addEventListener("click", () => {
    const colorMode = control.dataset.mapColor === "partisanship" ? "partisanship" : "district"
    activateMapColorMode(colorMode)
  })
}
for (const control of elements.resolutionButtons) {
  control.addEventListener("click", () => {
    activateResolution(control.dataset.resolution === "precinct" ? "precinct" : "block-group")
    void loadSelectedState()
  })
}
elements.tolerance.addEventListener("input", syncRangeLabels)
elements.county.addEventListener("input", syncRangeLabels)
elements.randomSeed.addEventListener("click", () => { elements.seed.value = randomSeed() })
elements.generate.addEventListener("click", () => {
  if (recomWorker) cancelGeneration()
  else {
    const initialAssignment = handoffInitialAssignment
    handoffInitialAssignment = null
    void generate(initialAssignment ?? undefined)
  }
})
elements.copy.addEventListener("click", () => void copySetup())
elements.download.addEventListener("click", downloadAssignment)
elements.sendResigned2.addEventListener("click", sendToResigned2)
elements.handoffClose.addEventListener("click", hideHandoff)
elements.openAnalytics.addEventListener("click", () => {
  if (analytics) elements.analyticsPanel.hidden = false
})
elements.openExplorer.addEventListener("click", () => openProposalExplorer())
elements.closeAnalytics.addEventListener("click", () => { elements.analyticsPanel.hidden = true })
elements.analyticsTabs.addEventListener("click", (event) => {
  const target = event.target as HTMLButtonElement
  const tab = target.dataset.tab
  if (!tab || !analytics) return
  elements.analyticsTabs.querySelectorAll("button").forEach((button) => {
    button.toggleAttribute("aria-current", button === target)
  })
  renderAnalytics(tab, analytics)
})
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    elements.analyticsPanel.hidden = true
    proposalPanel.close()
  }
})

if (!receiveResigned2Handoff()) void loadSelectedState()

async function loadSelectedState() {
  const resolution = currentResolution()
  const selectedDataset = datasetSlug(elements.state.value, resolution)
  cancelGeneration()
  loaded = null
  assignment = null
  handoffInitialAssignment = null
  sampleAssignment = null
  bestAssignment = null
  frontierScores = []
  proposalTrace = []
  proposalInitialAssignment = null
  proposalInitialScore = null
  proposalScoreOverride = null
  selectedProposal = null
  proposalPanel.reset()
  lastStatus = null
  analytics = null
  unitLookup = new Map()
  viewerMap?.destroy()
  viewerMap = null
  activateMapColorMode("district")
  clearResult()
  setError(null)
  setControls(false)
  setTelemetry("loading")
  elements.loadState.hidden = false
  elements.loadLabel.textContent = "Loading manifest"
  elements.runLabel.textContent = "Loading data"
  elements.mapState.textContent = stateBySlug.get(elements.state.value)?.name ?? "State"
  elements.mapStatus.textContent = `Loading ${resolutionLabel(resolution).toLowerCase()}`
  elements.unitsLabel.textContent = resolution === "precinct" ? "Precincts" : "Block groups"
  elements.units.textContent = "—"
  elements.districts.textContent = "—"
  elements.edges.textContent = "—"
  updateUrl()

  try {
    const bundle = await loadState(selectedDataset, (phase) => {
      elements.loadLabel.textContent = phase
    })
    if (bundle.manifest.state.slug !== datasetSlug(elements.state.value, currentResolution())) return
    loaded = bundle
    unitLookup = new Map(bundle.units.map((unit) => [unit.unitId, unit]))
    elements.units.textContent = bundle.manifest.counts.units.toLocaleString()
    elements.districts.textContent = bundle.manifest.counts.districts.toLocaleString()
    elements.edges.textContent = bundle.manifest.counts.adjacencyEdges?.toLocaleString() ?? "—"
    elements.loadState.hidden = true
    elements.islandNote.hidden = bundle.virtualEdges === 0
    elements.islandNote.textContent = `${bundle.virtualEdges.toLocaleString()} deterministic virtual island link${bundle.virtualEdges === 1 ? "" : "s"} added, preferring units in the same reference district.`
    elements.mapState.textContent = bundle.manifest.state.stateName
    elements.mapStatus.textContent = `${resolution === "precinct" ? "Precincts" : "Block groups"} · awaiting generation`
    viewerMap = new ViewerMap(elements.map, bundle.manifest, renderHover)
    viewerMap.setColorMode(currentMapColorMode())
    setControls(true)
    setTelemetry("ready")
    elements.runLabel.textContent = "Ready to generate"
    elements.generationNote.textContent = bundle.manifest.counts.districts === 1
      ? `${bundle.manifest.state.stateName} is at-large, so generation assigns every ${resolution === "precinct" ? "precinct" : "block group"} to District 1.`
      : `ReCom reuses the published ${resolutionLabel(resolution).toLowerCase()} reference assignment when it satisfies the selected tolerance. Otherwise it deterministically seeds a balanced contiguous plan before advancing the proposal chain.`
  } catch (error) {
    setError(message(error))
    setTelemetry("failed")
    elements.loadLabel.textContent = "Dataset failed"
    elements.runLabel.textContent = "Unavailable"
    elements.mapStatus.textContent = "Dataset unavailable"
  }
}

async function generate(branchAssignment?: Uint16Array, sourceProposal?: number) {
  if (!loaded) return
  const requestedProposal = branchAssignment
    ? null
    : new URLSearchParams(location.search).get("proposal")
  let params: ReturnType<typeof readControls>
  try {
    params = readControls(loaded.manifest.counts.districts)
  } catch (error) {
    setError(message(error))
    return
  }
  updateUrl()
  analytics = null
  assignment = null
  sampleAssignment = null
  bestAssignment = null
  frontierScores = []
  proposalTrace = []
  proposalInitialAssignment = null
  proposalInitialScore = null
  proposalScoreOverride = null
  selectedProposal = null
  proposalPanel.reset()
  if (requestedProposal === null) updateProposalUrl(null)
  lastStatus = null
  clearResult()
  setError(null)

  if (params.districts === 1) {
    sampleAssignment = Object.fromEntries(loaded.graph.unitIds.map((unitId) => [unitId, 1]))
    bestAssignment = sampleAssignment
    assignment = sampleAssignment
    lastStatus = emptyStatus()
    finishPlan(params.seed)
    return
  }

  requestId += 1
  const currentRequest = requestId
  const worker = new ReComWorker()
  recomWorker = worker
  setTelemetry("running")
  elements.generate.textContent = "Cancel"
  elements.runLabel.textContent = `Running 0 / ${params.steps.toLocaleString()} proposals`
  if (sourceProposal !== undefined) {
    elements.generationNote.textContent = `This chain branches from proposal ${sourceProposal.toLocaleString()} of the preceding run using the current controls and seed.`
  } else if (branchAssignment) {
    elements.generationNote.textContent = "This chain starts from the complete map received from Resigned2."
  }
  setFormDisabled(true)

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    if (response.requestId !== 0 && response.requestId !== currentRequest) return
    if (response.type === "ready") return
    if (response.type === "progress") {
      lastStatus = response.status
      proposalTrace.push(response.trace)
      const percent = (response.completed / Math.max(1, params.steps)) * 100
      setProgress(percent)
      elements.runLabel.textContent = `Running ${response.completed.toLocaleString()} / ${params.steps.toLocaleString()} proposals`
      renderScore(response.status)
      return
    }
    recomWorker = null
    worker.terminate()
    setFormDisabled(false)
    elements.generate.textContent = "Generate again"
    if (response.type === "error") {
      setError(response.error)
      setTelemetry("failed")
      elements.runLabel.textContent = "Generation failed"
      return
    }
    lastStatus = response.status
    sampleAssignment = denseToAssignment(loaded?.graph.unitIds ?? [], response.assignment)
    bestAssignment = denseToAssignment(loaded?.graph.unitIds ?? [], response.bestAssignment)
    frontierScores = response.frontier
    proposalInitialAssignment = response.initialAssignment
    proposalInitialScore = response.initialScore
    assignment = resultAssignment(currentResultMode(), sampleAssignment, bestAssignment)
    finishPlan(params.seed)
    elements.openExplorer.hidden = proposalTrace.length === 0
    if (requestedProposal !== null) openProposalExplorer(Number(requestedProposal))
  }
  worker.onerror = (event) => {
    recomWorker = null
    worker.terminate()
    setFormDisabled(false)
    setTelemetry("failed")
    elements.generate.textContent = "Generate plan"
    setError(event.message || "The ReCom worker failed.")
  }

  const graph = loaded.graph
  const request: WorkerRequest = {
    type: "run",
    requestId: currentRequest,
    graph: {
      edgeCountyCross: graph.edgeCountyCross.slice().buffer,
      ...(graph.edgeWeights ? { edgeWeights: graph.edgeWeights.slice().buffer } : {}),
      neighbors: graph.neighbors.slice().buffer,
      offsets: graph.offsets.slice().buffer,
      populations: graph.populations.slice().buffer,
    },
    params: {
      ...params,
      ...(branchAssignment
        ? { initialAssignment: branchAssignment.slice().buffer }
        : assignmentWithinTolerance(
            loaded.units,
            loaded.initialAssignment,
            params.districts,
            params.popTolerance,
          ) ? { initialAssignment: loaded.initialAssignment.slice().buffer } : {}),
    },
  }
  const transfers = [
    request.graph.edgeCountyCross,
    request.graph.neighbors,
    request.graph.offsets,
    request.graph.populations,
  ]
  if (request.graph.edgeWeights) transfers.push(request.graph.edgeWeights)
  if (request.params.initialAssignment) transfers.push(request.params.initialAssignment)
  worker.postMessage(request, transfers)
}

function finishPlan(seed: bigint, openAnalytics = true) {
  if (!loaded || !assignment || !lastStatus) return
  const selectedStatus = proposalScoreOverride
    ? { ...lastStatus, currentScore: proposalScoreOverride }
    : resultStatus(currentResultMode(), lastStatus)
  analytics = computeAnalytics(
    loaded.units,
    assignment,
    loaded.manifest.counts.districts,
    selectedStatus,
  )
  viewerMap?.setAssignment(
    assignment,
    analytics.districts.map((district) => district.election.demShare),
  )
  const partisanControl = elements.mapColorButtons.find(
    (control) => control.dataset.mapColor === "partisanship",
  )
  if (partisanControl) partisanControl.disabled = false
  renderScore(selectedStatus)
  setProgress(100)
  setTelemetry("done")
  elements.runLabel.textContent = selectedProposal === null
    ? `${loaded.manifest.counts.districts}-district ${currentResultMode() === "optimized" ? "optimized" : "sample"} ready`
    : `Proposal ${selectedProposal.toLocaleString()} selected`
  elements.mapStatus.textContent = `${loaded.manifest.editUnit === "precinct" ? "Precincts" : "Block groups"} · ${selectedProposal === null ? "generated plan" : `proposal ${selectedProposal.toLocaleString()}`}`
  elements.generate.textContent = "Generate again"
  elements.population.textContent = Math.round(analytics.totalPopulation).toLocaleString()
  elements.ideal.textContent = Math.round(analytics.idealPopulation).toLocaleString()
  elements.deviation.textContent = `${analytics.maxDeviationPercent.toFixed(2)}%`
  elements.resultSeed.textContent = seed.toString()
  elements.resultSection.hidden = false
  elements.analyticsSubtitle.textContent = `${analytics.districts.length} districts · ${analytics.totalUnits.toLocaleString()} ${loaded.manifest.editUnit === "precinct" ? "precincts" : "block groups"} · census and 2024 presidential diagnostics`
  renderAnalytics("overview", analytics)
  if (openAnalytics) elements.analyticsPanel.hidden = false
}

function cancelGeneration() {
  recomWorker?.terminate()
  recomWorker = null
  setFormDisabled(false)
  elements.generate.textContent = assignment ? "Generate again" : "Generate plan"
  if (loaded) {
    setTelemetry(assignment ? "done" : "ready")
    elements.runLabel.textContent = assignment ? "Plan ready" : "Ready to generate"
  }
}

function renderScore(status: ChainStatus) {
  elements.scoreGrid.hidden = false
  elements.accepted.textContent = status.stepsAccepted.toLocaleString()
  elements.rejected.textContent = status.stepsRejected.toLocaleString()
  elements.cut.textContent = status.currentScore.weightedCut.toLocaleString()
  elements.splits.textContent = status.currentScore.countySplits.toLocaleString()
}

function clearResult() {
  elements.resultSection.hidden = true
  elements.openExplorer.hidden = true
  elements.scoreGrid.hidden = true
  setProgress(0)
  if (viewerMap) viewerMap.setAssignment({})
  activateMapColorMode("district")
  elements.analyticsPanel.hidden = true
  elements.mapHover.hidden = true
}

function readControls(districts: number) {
  const seed = BigInt(elements.seed.value)
  if (seed < 0n || seed > 0xffff_ffff_ffff_ffffn) throw new Error("Seed must fit an unsigned 64-bit integer.")
  return {
    districts,
    seed,
    steps: boundedInteger(elements.steps.value, 0, 100_000),
    treeAttempts: boundedInteger(elements.attempts.value, 1, 20),
    burstLength: boundedInteger(elements.burst.value, 0, 10_000),
    popTolerance: Number(elements.tolerance.value) / 100,
    countySurcharge: Number(elements.county.value),
  }
}

function readSetup() {
  const query = new URLSearchParams(location.search)
  const requestedState = query.get("state") ?? "tx"
  return {
    state: stateBySlug.has(requestedState) ? requestedState : "tx",
    resolution: resolutionFromQuery(query.get("resolution")),
    seed: /^\d+$/.test(query.get("seed") ?? "") ? query.get("seed") ?? "42" : "42",
    steps: boundedInteger(query.get("steps") ?? "200", 0, 100_000),
    attempts: boundedInteger(query.get("attempts") ?? "3", 1, 20),
    burst: boundedInteger(query.get("burst") ?? "0", 0, 10_000),
    tolerance: boundedNumber(query.get("tolerance"), 0.5, 15, 5),
    county: boundedNumber(query.get("county"), 0, 50, 10),
    resultMode: resultModeFromQuery(query.get("output")),
  }
}

function updateUrl() {
  const url = new URL(location.href)
  url.searchParams.set("state", elements.state.value)
  url.searchParams.set("resolution", currentResolution())
  url.searchParams.set("seed", elements.seed.value)
  url.searchParams.set("steps", elements.steps.value)
  url.searchParams.set("attempts", elements.attempts.value)
  url.searchParams.set("burst", elements.burst.value)
  url.searchParams.set("tolerance", elements.tolerance.value)
  url.searchParams.set("county", elements.county.value)
  url.searchParams.set("output", currentResultMode())
  history.replaceState(null, "", url)
}

function updateProposalUrl(proposal: number | null) {
  const url = new URL(location.href)
  if (proposal === null) url.searchParams.delete("proposal")
  else url.searchParams.set("proposal", String(proposal))
  history.replaceState(null, "", url)
}

async function copySetup() {
  updateUrl()
  await navigator.clipboard.writeText(location.href)
  elements.copy.textContent = "Copied"
  setTimeout(() => { elements.copy.textContent = "Copy setup" }, 1_500)
}

/** Opens a strict-origin receiver before data loading so Resigned2 can seed this tab. */
function receiveResigned2Handoff() {
  const token = handoffTokenFromURL()
  if (!token) return false
  const opener = window.opener
  if (!opener) {
    showHandoff(
      "resigned2-to-recom",
      "error",
      "Handoff interrupted",
      "This ReCom tab is no longer connected to Resigned2. You can still use ReCom normally.",
    )
    return false
  }

  const sourceOrigin = resigned2Origin()
  let handled = false
  showHandoff(
    "resigned2-to-recom",
    "connecting",
    "Connecting Resigned2 and ReCom",
    "Waiting for Resigned2 to send the active map context.",
  )
  const timeout = window.setTimeout(() => {
    if (handled) return
    showHandoff(
      "resigned2-to-recom",
      "error",
      "Handoff interrupted",
      "Resigned2 did not send a map. Close this message and try the handoff again.",
    )
    cleanup()
    void loadSelectedState()
  }, 20_000)
  const receive = (event: MessageEvent<unknown>) => {
    if (
      handled
      || event.origin !== sourceOrigin
      || event.source !== opener
      || !isHandoffMessage(event.data, "resigned2-to-recom", "context", token)
    ) return
    handled = true
    window.clearTimeout(timeout)
    showHandoff(
      "resigned2-to-recom",
      "transferring",
      "Receiving the Resigned2 map",
      "The dataset and assignment are moving directly between these browser tabs.",
    )
    void Promise.resolve()
      .then(() => parseLaunchContextMessage(event.data, token))
      .then(applyResigned2Context)
      .then(() => {
        opener.postMessage(
          handoffMessage("resigned2-to-recom", "complete", token),
          sourceOrigin,
        )
        showHandoff(
          "resigned2-to-recom",
          "accepted",
          "Map received",
          "ReCom is ready to continue from the Resigned2 context.",
        )
        window.setTimeout(hideHandoff, 850)
      })
      .catch((error: unknown) => {
        const detail = message(error)
        opener.postMessage(
          handoffMessage("resigned2-to-recom", "error", token, { error: detail }),
          sourceOrigin,
        )
        showHandoff(
          "resigned2-to-recom",
          "error",
          "Handoff interrupted",
          detail,
        )
      })
      .finally(cleanup)
  }
  const cleanup = () => {
    window.clearTimeout(timeout)
    window.removeEventListener("message", receive)
  }
  window.addEventListener("message", receive)
  opener.postMessage(handoffMessage("resigned2-to-recom", "ready", token), sourceOrigin)
  return true
}

/** Loads the requested dataset, displays partial maps, and seeds ReCom only from complete maps. */
async function applyResigned2Context(context: Resigned2LaunchContext) {
  const selection = datasetSelection(context.datasetSlug)
  elements.state.value = selection.stateSlug
  activateResolution(selection.resolution)
  await loadSelectedState()
  if (!loaded || loaded.manifest.state.slug !== context.datasetSlug) {
    throw new Error("ReCom could not load the Resigned2 dataset.")
  }
  if (loaded.manifest.counts.districts !== context.districtCount) {
    throw new Error("The Resigned2 district count does not match this ReCom dataset.")
  }

  if (!context.assignment) {
    elements.generationNote.textContent = `${context.title ?? "The Resigned2 plan"} opened this dataset. Generate a plan when the controls are ready.`
    return
  }
  const knownUnitIDs = new Set(loaded.graph.unitIds)
  const unknownUnitID = Object.keys(context.assignment).find((unitID) => !knownUnitIDs.has(unitID))
  if (unknownUnitID) {
    throw new Error(`The Resigned2 map contains an unavailable unit (${unknownUnitID}).`)
  }

  assignment = context.assignment
  viewerMap?.setAssignment(assignment)
  const assignedCount = Object.keys(assignment).length
  const complete = assignedCount === loaded.graph.unitIds.length
  if (complete) handoffInitialAssignment = assignmentToDense(loaded.graph.unitIds, assignment)
  elements.mapStatus.textContent = `${loaded.manifest.editUnit === "precinct" ? "Precincts" : "Block groups"} · Resigned2 map`
  elements.runLabel.textContent = complete ? "Resigned2 map ready" : "Partial Resigned2 map received"
  elements.generationNote.textContent = complete
    ? `${context.title ?? "The Resigned2 plan"} is the starting assignment for the next ReCom chain.`
    : `${assignedCount.toLocaleString()} of ${loaded.graph.unitIds.length.toLocaleString()} units were assigned in Resigned2. The map is shown here, but generation will use ReCom's complete default starting plan.`
}

/** Sends one immutable generated-plan snapshot to the exact Resigned2 window opened here. */
function sendToResigned2() {
  let plan: ReComPlanHandoff
  try {
    plan = currentPlanHandoff()
  } catch (error) {
    showHandoff(
      "recom-to-resigned2",
      "error",
      "Map is not ready",
      message(error),
    )
    return
  }

  handoffCleanup()
  const token = createHandoffToken()
  const targetOrigin = resigned2Origin()
  const resignedWindow = window.open(resigned2HandoffURL(token), "_blank")
  if (!resignedWindow) {
    showHandoff(
      "recom-to-resigned2",
      "error",
      "Handoff interrupted",
      "The browser blocked the Resigned2 tab. Allow pop-ups and try again.",
    )
    return
  }

  let planSent = false
  showHandoff(
    "recom-to-resigned2",
    "connecting",
    "Connecting ReCom and Resigned2",
    "Waiting for Resigned2 to confirm the private connection.",
  )
  const timeout = window.setTimeout(() => {
    showHandoff(
      "recom-to-resigned2",
      "error",
      "Handoff interrupted",
      "Resigned2 did not confirm the connection. Close its tab and try again.",
    )
    cleanup()
  }, 20_000)
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== targetOrigin || event.source !== resignedWindow) return
    if (
      !planSent
      && isHandoffMessage(event.data, "recom-to-resigned2", "ready", token)
    ) {
      planSent = true
      showHandoff(
        "recom-to-resigned2",
        "transferring",
        "Sending the generated map",
        "The assignment is moving directly between these browser tabs.",
      )
      resignedWindow.postMessage(
        handoffMessage("recom-to-resigned2", "plan", token, { plan }),
        targetOrigin,
      )
      return
    }
    if (isHandoffMessage(event.data, "recom-to-resigned2", "complete", token)) {
      showHandoff(
        "recom-to-resigned2",
        "accepted",
        "Map received by Resigned2",
        "The generated assignment is saved as a local Resigned2 draft.",
      )
      cleanup()
      window.setTimeout(hideHandoff, 850)
      return
    }
    if (isHandoffMessage(event.data, "recom-to-resigned2", "error", token)) {
      showHandoff(
        "recom-to-resigned2",
        "error",
        "Handoff interrupted",
        typeof event.data.error === "string" ? event.data.error : "Resigned2 could not import this map.",
      )
      cleanup()
    }
  }
  const cleanup = () => {
    window.clearTimeout(timeout)
    window.removeEventListener("message", receive)
    handoffCleanup = () => {}
  }
  handoffCleanup = cleanup
  window.addEventListener("message", receive)
}

function currentPlanHandoff(): ReComPlanHandoff {
  if (!loaded || !assignment || !lastStatus) {
    throw new Error("Generate a complete ReCom plan before opening it in Resigned2.")
  }
  return {
    assignment,
    datasetSlug: loaded.manifest.state.slug,
    districtCount: loaded.manifest.counts.districts,
    generatedAt: new Date().toISOString(),
    output: selectedProposal === null ? currentResultMode() : "proposal",
    proposal: selectedProposal,
    seed: elements.seed.value,
    unitCount: loaded.graph.unitIds.length,
  }
}

function showHandoff(
  direction: HandoffDirection,
  phase: HandoffAnimationPhase,
  title: string,
  detail: string,
) {
  elements.handoffVisual.dataset.direction = direction
  elements.handoffVisual.dataset.phase = phase
  elements.handoffVisual.setAttribute("aria-label", title)
  elements.handoffTitle.textContent = title
  elements.handoffDetail.textContent = detail
  elements.handoffPacket.textContent = phase === "accepted" ? "✓" : phase === "error" ? "×" : ""
  elements.handoffClose.hidden = phase !== "error"
  elements.handoffDialog.hidden = false
}

function hideHandoff() {
  if (elements.handoffVisual.dataset.phase !== "error") handoffCleanup()
  elements.handoffDialog.hidden = true
}

function downloadAssignment() {
  if (!loaded || !assignment || !lastStatus) return
  const selectedStatus = proposalScoreOverride
    ? { ...lastStatus, currentScore: proposalScoreOverride }
    : resultStatus(currentResultMode(), lastStatus)
  const payload = {
    algorithm: "recom-core",
    algorithmVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    resolution: currentResolution(),
    state: loaded.manifest.state,
    params: {
      seed: elements.seed.value,
      steps: Number(elements.steps.value),
      treeAttempts: Number(elements.attempts.value),
      burstLength: boundedInteger(elements.burst.value, 0, 10_000),
      populationTolerancePercent: Number(elements.tolerance.value),
      countySurcharge: Number(elements.county.value),
    },
    output: selectedProposal === null ? currentResultMode() : "proposal",
    proposal: selectedProposal,
    status: selectedStatus,
    analytics,
    assignment,
    optimization: {
      bestAssignment,
      frontierScores,
    },
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${loaded.manifest.state.slug}-recom-${elements.seed.value}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function activateResultMode(mode: ResultMode) {
  for (const control of elements.resultModeButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.resultMode === mode))
  }
  elements.resultModeHelp.textContent = mode === "optimized"
    ? "Optimize uses recom-scoring's deterministic Pareto selection."
    : "Sample preserves the final neutral chain state."
  if (sampleAssignment && bestAssignment && lastStatus) {
    assignment = resultAssignment(mode, sampleAssignment, bestAssignment)
    finishPlan(BigInt(elements.seed.value), false)
  }
  updateUrl()
}

function openProposalExplorer(requestedProposal?: number) {
  if (!loaded || !proposalInitialAssignment || !proposalInitialScore || proposalTrace.length === 0) return
  proposalPanel.open({
    chunks: proposalTrace,
    districtCount: loaded.manifest.counts.districts,
    frontier: frontierScores,
    initialAssignment: proposalInitialAssignment,
    initialScore: proposalInitialScore,
    selectedProposal: Number.isFinite(requestedProposal)
      ? Math.max(0, Math.floor(requestedProposal ?? 0))
      : selectedProposal
        ?? (lastStatus
          ? lastStatus.stepsAccepted + lastStatus.stepsRejected + lastStatus.burstRestarts
          : 0),
    storageKey: `${loaded.manifest.state.slug}:${elements.seed.value}`,
    unitVotes: loaded.graph.unitIds.map((unitId) => {
      const result = unitLookup.get(unitId)?.president2024
      return { dem: result?.dem ?? 0, rep: result?.rep ?? 0 }
    }),
  })
}

function currentResultMode(): ResultMode {
  return elements.resultModeButtons.find(
    (control) => control.getAttribute("aria-pressed") === "true",
  )?.dataset.resultMode === "optimized"
    ? "optimized"
    : "sample"
}

function renderHover(unitId: string | null) {
  const unit = unitId ? unitLookup.get(unitId) : undefined
  if (!unit) {
    elements.mapHover.hidden = true
    return
  }
  const district = assignment?.[unit.unitId] ?? 0
  const districtAnalytics = district ? analytics?.districts[district - 1] : undefined
  const totalVotes = unit.president2024.dem + unit.president2024.rep
  const demShare = totalVotes ? unit.president2024.dem / totalVotes : null
  elements.mapHover.innerHTML = `
    <header><div><span>${escapeHtml(unit.countyName || `County ${unit.countyFips}`)}</span><strong>${escapeHtml(unit.label || unit.unitId)}</strong></div><b>${district ? `D${district}` : "—"}</b></header>
    <div class="map-hover-stats">
      ${hoverMetric("Unit population", formatInteger(unit.popTotal))}
      ${hoverMetric("District deviation", districtAnalytics ? formatSigned(districtAnalytics.deviationPercent / 100) : "—")}
      ${hoverMetric("District population", districtAnalytics ? formatInteger(districtAnalytics.population) : "—")}
      ${hoverMetric("District counties", districtAnalytics ? String(districtAnalytics.counties) : "—")}
    </div>
    <div class="map-hover-shares">
      ${hoverShare("White alone", unit.popWhite, unit.popTotal)}
      ${hoverShare("Black alone", unit.popBlack, unit.popTotal)}
      ${hoverShare("Hispanic / Latino", unit.popHispanic, unit.popTotal)}
      ${hoverShare("Asian alone", unit.popAsian, unit.popTotal)}
    </div>
    <div class="map-hover-election">
      <span>2024 presidential two-party</span>
      ${demShare === null ? "<strong>Unavailable</strong>" : `<i><b style="width:${demShare * 100}%"></b></i><div><strong>D ${formatPercent(demShare)}</strong><strong>R ${formatPercent(1 - demShare)}</strong></div>`}
    </div>
    <small>${loaded?.manifest.editUnit === "precinct" ? "PRECINCT" : "BLOCK GROUP"} ${escapeHtml(unit.unitId)}</small>
  `
  elements.mapHover.hidden = false
}

function renderAnalytics(tab: string, data: PlanAnalytics) {
  elements.analyticsBody.innerHTML = tab === "population"
    ? populationAnalytics(data)
    : tab === "demographics"
      ? demographicAnalytics(data)
      : tab === "elections"
        ? electionAnalytics(data)
        : tab === "districts"
          ? districtAnalytics(data)
          : overviewAnalytics(data)
}

function overviewAnalytics(data: PlanAnalytics) {
  return `
    <section><h3><span>01</span> Plan snapshot</h3>${statGrid([
      ["Total population", formatInteger(data.totalPopulation)],
      ["Ideal district", formatInteger(data.idealPopulation)],
      ["Max deviation", formatPercent(data.maxDeviationPercent / 100)],
      ["Mean abs. deviation", formatPercent(data.meanAbsoluteDeviationPercent / 100)],
      ["Accepted proposals", formatPercent(data.acceptanceRate)],
      ["Weighted cut / district", data.weightedCutPerDistrict.toFixed(1)],
      ["Split counties", `${data.counties.splitCount} / ${data.counties.total}`],
      ["Competitive seats", String(data.election.competitiveDistricts)],
    ])}</section>
    <section><h3><span>02</span> Population balance</h3>${deviationChart(data.districts, true)}</section>
    <section class="analytics-columns"><div><h3><span>03</span> Statewide demographics</h3>${shareBars(data)}</div><div><h3><span>04</span> Electoral profile</h3>${electionSummary(data)}</div></section>
    ${methodology("Population uses published unit totals. County splits and demographics are recomputed from the generated assignment; weighted cut and acceptance come from recom-core.")}
  `
}

function populationAnalytics(data: PlanAnalytics) {
  const buckets = [0.5, 1, 2, 3, 5, Number.POSITIVE_INFINITY]
  const counts = buckets.map(() => 0)
  for (const district of data.districts) {
    const index = buckets.findIndex((maximum) => Math.abs(district.deviationPercent) <= maximum)
    if (index >= 0) counts[index] = (counts[index] ?? 0) + 1
  }
  const maximum = Math.max(1, ...counts)
  const labels = ["≤0.5%", "≤1%", "≤2%", "≤3%", "≤5%", ">5%"]
  return `
    <section><h3><span>01</span> District deviations</h3><p>Signed deviation from the statewide ideal; left is under-populated and right is over-populated.</p>${deviationChart(data.districts)}</section>
    <section><h3><span>02</span> Absolute-deviation distribution</h3><div class="histogram">${counts.map((count, index) => `<div><i style="height:${(count / maximum) * 100}%"></i><strong>${count}</strong><small>${labels[index]}</small></div>`).join("")}</div></section>
    <section><h3><span>03</span> Balance diagnostics</h3>${statGrid([
      ["Population range", formatInteger(data.populationRange)],
      ["Median abs. deviation", formatPercent(data.medianAbsoluteDeviationPercent / 100)],
      ["Within 1%", String(data.districts.filter((district) => Math.abs(district.deviationPercent) <= 1).length)],
      ["Within 3%", String(data.districts.filter((district) => Math.abs(district.deviationPercent) <= 3).length)],
    ])}</section>
  `
}

function demographicAnalytics(data: PlanAnalytics) {
  return `
    <section><h3><span>01</span> Statewide reported shares</h3>${shareBars(data, true)}</section>
    <section><h3><span>02</span> Descriptive thresholds</h3>${statGrid([
      ["White-alone below 50%", String(data.demographics.majorityNonWhiteDistricts)],
      ["Black 40%+", String(data.demographics.black40)],
      ["Hispanic 40%+", String(data.demographics.hispanic40)],
      ["Asian 30%+", String(data.demographics.asian30)],
    ])}</section>
    <section><h3><span>03</span> District demographic matrix</h3><p>Each group is reported independently as a share of district population.</p><div class="demographic-matrix"><div class="matrix-row matrix-head"><b>District</b>${demographicKeys.slice(0, 4).map((key) => `<b>${demographicLabel(key)}</b>`).join("")}</div>${data.districts.map((district) => `<div class="matrix-row"><strong>D${pad(district.district)}</strong>${demographicKeys.slice(0, 4).map((key) => `<span style="--heat:${district.demographicShares[key]}">${formatPercent(district.demographicShares[key])}</span>`).join("")}</div>`).join("")}</div></section>
    ${methodology("Race-alone and Hispanic/Latino counts are independently reported Census measures and can overlap; they are not a mutually exclusive composition.")}
  `
}

function electionAnalytics(data: PlanAnalytics) {
  return `
    <section><h3><span>01</span> Statewide two-party profile</h3>${electionSummary(data, true)}</section>
    <section><h3><span>02</span> District presidential vote</h3><p>2024 presidential Democratic two-party share; outlined rows are within five points.</p><div class="election-chart">${data.districts.map((district) => {
      const share = district.election.demShare
      return `<div><span>D${pad(district.district)}</span><i class="${share !== null && Math.abs(share - 0.5) < 0.05 ? "competitive" : ""}"><b style="width:${(share ?? 0.5) * 100}%"></b><em></em></i><strong>${optionalPercent(share)}</strong></div>`
    }).join("")}</div></section>
    <section><h3><span>03</span> Representation diagnostics</h3>${statGrid([
      ["D seats", String(data.election.demSeats)], ["R seats", String(data.election.repSeats)],
      ["Competitive", String(data.election.competitiveDistricts)], ["Median district D", optionalPercent(data.election.medianDistrictDemShare)],
      ["Mean–median gap", optionalSigned(data.election.meanMedianGap)], ["Seat–vote gap", optionalSigned(data.election.seatVoteGap)],
      ["Efficiency gap", optionalSigned(data.election.efficiencyGap)], ["Reporting votes", formatInteger(data.election.twoPartyVotes)],
    ])}</section>
    ${methodology("Election shares use 2024 presidential Democratic–Republican two-party vote. Efficiency gap uses the standard half-plus-one wasted-vote threshold.")}
  `
}

function districtAnalytics(data: PlanAnalytics) {
  return `<section><h3><span>01</span> District diagnostic table</h3><p>Population, balance, geography, presidential vote, and independently reported demographic shares.</p><div class="district-table-wrap"><table><thead><tr><th>District</th><th>Population</th><th>Deviation</th><th>Units</th><th>Counties</th><th>D share</th><th>Black</th><th>Hispanic</th><th>Asian</th><th>White</th></tr></thead><tbody>${data.districts.map((district) => `<tr><th>D${pad(district.district)}</th><td>${formatInteger(district.population)}</td><td>${formatSigned(district.deviationPercent / 100)}</td><td>${formatInteger(district.units)}</td><td>${district.counties}</td><td>${optionalPercent(district.election.demShare)}</td><td>${formatPercent(district.demographicShares.black)}</td><td>${formatPercent(district.demographicShares.hispanic)}</td><td>${formatPercent(district.demographicShares.asian)}</td><td>${formatPercent(district.demographicShares.white)}</td></tr>`).join("")}</tbody></table></div></section>`
}

function statGrid(items: Array<[string, string]>) {
  return `<div class="analytics-stats">${items.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`
}

function deviationChart(districts: PlanAnalytics["districts"], compact = false) {
  const maximum = Math.max(0.5, ...districts.map((district) => Math.abs(district.deviationPercent)))
  const shown = compact && districts.length > 20
    ? [...districts].sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent)).slice(0, 12)
    : districts
  return `<div class="deviation-chart">${shown.map((district) => `<div><span>D${pad(district.district)}</span><i><b class="${district.deviationPercent < 0 ? "left" : "right"}" style="width:${(Math.abs(district.deviationPercent) / maximum) * 50}%"></b></i><strong>${formatSigned(district.deviationPercent / 100)}</strong></div>`).join("")}</div>`
}

function shareBars(data: PlanAnalytics, populations = false) {
  return `<div class="share-bars">${demographicKeys.map((key) => `<div><span>${demographicLabel(key)}</span><i><b style="width:${Math.min(100, data.demographics.shares[key] * 100)}%"></b></i><strong>${formatPercent(data.demographics.shares[key])}</strong>${populations ? `<small>${formatInteger(data.demographics.totals[key])}</small>` : ""}</div>`).join("")}</div>`
}

function electionSummary(data: PlanAnalytics, expanded = false) {
  const demShare = data.election.demShare ?? 0
  const reporting = Math.max(1, data.election.demSeats + data.election.repSeats)
  return `<div class="election-summary"><i><b style="width:${demShare * 100}%"></b><em></em></i><div><strong>D ${optionalPercent(data.election.demShare)}</strong><strong>R ${optionalPercent(data.election.repShare)}</strong></div><i class="seats"><b style="width:${(data.election.demSeats / reporting) * 100}%"></b></i><div><strong>${data.election.demSeats} D seats</strong><strong>${data.election.repSeats} R seats</strong></div>${expanded ? `<p>${formatInteger(data.election.demVotes)} Democratic and ${formatInteger(data.election.repVotes)} Republican votes.</p>` : ""}</div>`
}

function methodology(text: string) { return `<p class="methodology"><strong>Methodology.</strong> ${text}</p>` }
function hoverMetric(label: string, value: string) { return `<div><span>${label}</span><strong>${value}</strong></div>` }
function hoverShare(label: string, count: number, total: number) { const value = total ? count / total : 0; return `<div><span><b>${label}</b><small>${formatInteger(count)}</small></span><i><b style="width:${value * 100}%"></b></i><strong>${formatPercent(value)}</strong></div>` }
function demographicLabel(key: (typeof demographicKeys)[number]) { return ({ white: "White alone", black: "Black alone", hispanic: "Hispanic / Latino", asian: "Asian alone", native: "Native / Pacific" })[key] }
function formatInteger(value: number) { return Math.round(value).toLocaleString() }
function formatPercent(value: number) { return `${(value * 100).toFixed(1)}%` }
function formatSigned(value: number) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%` }
function optionalPercent(value: number | null) { return value === null ? "—" : formatPercent(value) }
function optionalSigned(value: number | null) { return value === null ? "—" : formatSigned(value) }
function pad(value: number) { return String(value).padStart(2, "0") }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character) }

function syncRangeLabels() {
  elements.toleranceOutput.textContent = `${Number(elements.tolerance.value).toFixed(1)}%`
  elements.countyOutput.textContent = elements.county.value
  for (const control of [elements.tolerance, elements.county]) {
    const minimum = Number(control.min)
    const share = (Number(control.value) - minimum) / (Number(control.max) - minimum)
    control.style.setProperty("--fill", `${share * 100}%`)
  }
}

function activateMapColorMode(colorMode: MapColorMode) {
  for (const control of elements.mapColorButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.mapColor === colorMode))
    if (control.dataset.mapColor === "partisanship" && !analytics) control.disabled = true
  }
  elements.partisanLegend.hidden = colorMode !== "partisanship"
  viewerMap?.setColorMode(colorMode)
}

function currentMapColorMode(): MapColorMode {
  return elements.mapColorButtons.find(
    (control) => control.getAttribute("aria-pressed") === "true",
  )?.dataset.mapColor === "partisanship"
    ? "partisanship"
    : "district"
}

function activateResolution(resolution: ViewerResolution) {
  for (const control of elements.resolutionButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.resolution === resolution))
  }
  elements.resolutionHelp.textContent = resolution === "precinct"
    ? "2024 election precincts; census statistics are allocated from source block groups."
    : "Census block groups with their native demographic estimates."
}

function currentResolution(): ViewerResolution {
  return elements.resolutionButtons.find((control) => control.getAttribute("aria-pressed") === "true")
    ?.dataset.resolution === "precinct"
    ? "precinct"
    : "block-group"
}

function setControls(enabled: boolean) {
  elements.generate.disabled = !enabled
  elements.copy.disabled = !enabled
}

function setFormDisabled(disabled: boolean) {
  for (const control of [elements.state, elements.seed, elements.steps, elements.attempts, elements.burst, elements.tolerance, elements.county, elements.randomSeed]) {
    control.disabled = disabled
  }
  for (const control of elements.resolutionButtons) control.disabled = disabled
}

type TelemetryState = "loading" | "ready" | "running" | "done" | "failed"

function setTelemetry(state: TelemetryState) {
  elements.telemetry.dataset.state = state
}

function setProgress(percent: number) {
  const bounded = Math.max(0, Math.min(100, percent))
  elements.runProgress.style.width = `${bounded}%`
  elements.runPercent.textContent = `${bounded.toFixed(0)}%`
}

function setError(error: string | null) {
  elements.error.hidden = !error
  elements.error.textContent = error ?? ""
}

function randomSeed() {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return ((BigInt(values[0] ?? 0) << 32n) | BigInt(values[1] ?? 0)).toString()
}

function emptyStatus(): ChainStatus {
  const score = { weightedCut: 0, countyFragments: 0, countySplits: 0, maxDeviationPpm: 0 }
  return { stepsAccepted: 0, stepsRejected: 0, burstRestarts: 0, currentScore: score, bestScore: score, frontierSize: 1 }
}

function boundedInteger(value: string, minimum: number, maximum: number) {
  return Math.round(boundedNumber(value, minimum, maximum, minimum))
}

function boundedNumber(value: string | null, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function get(id: string) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}.`)
  return element
}

function input(id: string) { return get(id) as HTMLInputElement }
function button(id: string) { return get(id) as HTMLButtonElement }
function select(id: string) { return get(id) as HTMLSelectElement }
