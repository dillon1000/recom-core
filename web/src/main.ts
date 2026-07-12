/**
 * Owns the standalone public viewer UI. Inputs are URL-backed controls and the
 * 50-state data loader; outputs are deterministic plans, live map updates,
 * shareable setup URLs, and portable JSON assignments. Generation is always
 * local and unsigned—there is no account, upload, or server compute path.
 */
import "./style.css"

import { states, stateBySlug } from "./catalog"
import { loadState, type LoadedState } from "./data"
import { denseToAssignment } from "./graph"
import { ViewerMap } from "./map"
import ReComWorker from "./recom.worker?worker"
import type { AssignmentMap, ChainStatus, WorkerRequest, WorkerResponse } from "./types"

const app = document.querySelector<HTMLElement>("#app")
if (!app) throw new Error("The viewer root is missing.")

app.innerHTML = `
  <div class="viewer-shell">
    <aside class="viewer-sidebar">
      <header class="viewer-header">
        <div class="viewer-eyebrow"><span class="viewer-mark">AR</span><span>RECOM-CORE / PUBLIC VIEWER</span></div>
        <h1>Auto-redistricter</h1>
        <p>Generate contiguous, population-balanced congressional plans locally in your browser. No account, upload, or server compute.</p>
      </header>

      <section class="viewer-section" aria-labelledby="dataset-heading">
        <div class="section-heading"><span>01</span><h2 id="dataset-heading">Dataset</h2></div>
        <label class="field"><span>State</span><select id="state-select"></select></label>
        <div class="metric-grid metric-grid--three">
          <div class="metric"><span>Units</span><strong id="units-value">—</strong></div>
          <div class="metric"><span>Districts</span><strong id="districts-value">—</strong></div>
          <div class="metric"><span>Adj. edges</span><strong id="edges-value">—</strong></div>
        </div>
        <div class="load-state" id="load-state" role="status"><span class="progress"><i></i></span><span id="load-label">Loading state data</span></div>
        <p class="note" id="island-note" hidden></p>
      </section>

      <section class="viewer-section" aria-labelledby="parameters-heading">
        <div class="section-heading"><span>02</span><h2 id="parameters-heading">Parameters</h2></div>
        <label class="field"><span>Seed</span><div class="input-action"><input id="seed" inputmode="numeric" /><button id="random-seed" type="button" aria-label="Generate a random seed">↻</button></div><small>Same state, seed, and controls produce the same plan.</small></label>
        <div class="control-grid">
          <label class="field"><span>Proposals</span><input id="steps" type="number" min="0" max="100000" step="100" /></label>
          <label class="field"><span>Tree attempts</span><input id="attempts" type="number" min="1" max="20" /></label>
        </div>
        <label class="range-field"><span><span>Population tolerance</span><output id="tolerance-output">5.0%</output></span><input id="tolerance" type="range" min="0.5" max="15" step="0.5" /></label>
        <label class="range-field"><span><span>County preservation</span><output id="county-output">10</output></span><input id="county" type="range" min="0" max="50" step="1" /></label>
      </section>

      <section class="viewer-section" aria-labelledby="generation-heading">
        <div class="section-heading"><span>03</span><h2 id="generation-heading">Generation</h2></div>
        <div class="actions"><button class="button button--primary" id="generate" type="button" disabled>Generate plan</button><button class="button" id="copy" type="button" disabled>Copy setup</button></div>
        <div class="run-state" aria-live="polite"><span class="progress"><i id="run-progress"></i></span><span><b id="run-label">Loading data</b><b id="run-percent">0%</b></span></div>
        <div class="metric-grid metric-grid--two" id="score-grid" hidden>
          <div class="metric"><span>Accepted</span><strong id="accepted-value">0</strong></div>
          <div class="metric"><span>Rejected</span><strong id="rejected-value">0</strong></div>
          <div class="metric"><span>Best cut edges</span><strong id="cut-value">0</strong></div>
          <div class="metric"><span>County splits</span><strong id="splits-value">0</strong></div>
        </div>
        <p class="note" id="generation-note">ReCom starts from the published reference assignment, then advances the seeded proposal chain entirely inside a Web Worker.</p>
        <p class="error" id="error" role="alert" hidden></p>
      </section>

      <section class="viewer-section" id="result-section" aria-labelledby="result-heading" hidden>
        <div class="section-heading"><span>04</span><h2 id="result-heading">Result</h2></div>
        <div class="metric-grid metric-grid--two">
          <div class="metric"><span>Population</span><strong id="population-value">—</strong></div>
          <div class="metric"><span>Ideal / district</span><strong id="ideal-value">—</strong></div>
          <div class="metric"><span>Max deviation</span><strong id="deviation-value">—</strong></div>
          <div class="metric"><span>Seed</span><strong id="result-seed">—</strong></div>
        </div>
        <button class="button button--full" id="download" type="button">Download assignment JSON</button>
      </section>

      <footer class="viewer-footer"><span>MIT / DETERMINISTIC WASM</span><a href="https://github.com/dillon1000/recom-core">SOURCE</a></footer>
    </aside>
    <section class="viewer-map" aria-label="Generated district map">
      <div id="map" class="viewer-map__canvas"></div>
      <div class="map-label"><strong id="map-state">Loading</strong><span id="map-status">Authentic geography</span></div>
    </section>
  </div>
`

const elements = {
  accepted: get("accepted-value"), attempts: input("attempts"), copy: button("copy"),
  county: input("county"), countyOutput: get("county-output"), cut: get("cut-value"),
  deviation: get("deviation-value"), districts: get("districts-value"), download: button("download"),
  edges: get("edges-value"), error: get("error"), generate: button("generate"),
  generationNote: get("generation-note"), ideal: get("ideal-value"), islandNote: get("island-note"),
  loadLabel: get("load-label"), loadState: get("load-state"), map: get("map"),
  mapState: get("map-state"), mapStatus: get("map-status"), population: get("population-value"),
  randomSeed: button("random-seed"), rejected: get("rejected-value"), resultSection: get("result-section"),
  resultSeed: get("result-seed"), runLabel: get("run-label"), runPercent: get("run-percent"),
  runProgress: get("run-progress"), scoreGrid: get("score-grid"), seed: input("seed"),
  splits: get("splits-value"), state: select("state-select"), steps: input("steps"),
  tolerance: input("tolerance"), toleranceOutput: get("tolerance-output"), units: get("units-value"),
}

for (const state of states) {
  const option = document.createElement("option")
  option.value = state.slug
  option.textContent = `${state.name} · ${state.postal}`
  elements.state.append(option)
}

const setup = readSetup()
elements.state.value = setup.state
elements.seed.value = setup.seed
elements.steps.value = String(setup.steps)
elements.attempts.value = String(setup.attempts)
elements.tolerance.value = String(setup.tolerance)
elements.county.value = String(setup.county)
syncRangeLabels()

let loaded: LoadedState | null = null
let viewerMap: ViewerMap | null = null
let recomWorker: Worker | null = null
let assignment: AssignmentMap | null = null
let lastStatus: ChainStatus | null = null
let requestId = 0

elements.state.addEventListener("change", () => void loadSelectedState())
elements.tolerance.addEventListener("input", syncRangeLabels)
elements.county.addEventListener("input", syncRangeLabels)
elements.randomSeed.addEventListener("click", () => { elements.seed.value = randomSeed() })
elements.generate.addEventListener("click", () => {
  if (recomWorker) cancelGeneration()
  else void generate()
})
elements.copy.addEventListener("click", () => void copySetup())
elements.download.addEventListener("click", downloadAssignment)

void loadSelectedState()

async function loadSelectedState() {
  cancelGeneration()
  loaded = null
  assignment = null
  lastStatus = null
  viewerMap?.destroy()
  viewerMap = null
  clearResult()
  setError(null)
  setControls(false)
  elements.loadState.hidden = false
  elements.loadLabel.textContent = "Loading manifest"
  elements.runLabel.textContent = "Loading data"
  elements.mapState.textContent = stateBySlug.get(elements.state.value)?.name ?? "State"
  elements.mapStatus.textContent = "Loading authentic geography"
  elements.units.textContent = "—"
  elements.districts.textContent = "—"
  elements.edges.textContent = "—"
  updateUrl()

  try {
    const bundle = await loadState(elements.state.value, (phase) => {
      elements.loadLabel.textContent = phase
    })
    if (bundle.manifest.state.slug !== elements.state.value) return
    loaded = bundle
    elements.units.textContent = bundle.manifest.counts.units.toLocaleString()
    elements.districts.textContent = bundle.manifest.counts.districts.toLocaleString()
    elements.edges.textContent = bundle.manifest.counts.adjacencyEdges?.toLocaleString() ?? "—"
    elements.loadState.hidden = true
    elements.islandNote.hidden = bundle.virtualEdges === 0
    elements.islandNote.textContent = `${bundle.virtualEdges.toLocaleString()} deterministic virtual island link${bundle.virtualEdges === 1 ? "" : "s"} added, preferring units in the same reference district.`
    elements.mapState.textContent = bundle.manifest.state.stateName
    elements.mapStatus.textContent = "Awaiting generation"
    viewerMap = new ViewerMap(elements.map, bundle.manifest)
    setControls(true)
    elements.runLabel.textContent = "Ready to generate"
    elements.generationNote.textContent = bundle.manifest.counts.districts === 1
      ? `${bundle.manifest.state.stateName} is at-large, so generation assigns every unit to District 1.`
      : "ReCom starts from the published reference assignment, then advances the seeded proposal chain entirely inside a Web Worker."
  } catch (error) {
    setError(message(error))
    elements.loadLabel.textContent = "Dataset failed"
    elements.runLabel.textContent = "Unavailable"
    elements.mapStatus.textContent = "Dataset unavailable"
  }
}

async function generate() {
  if (!loaded) return
  let params: ReturnType<typeof readControls>
  try {
    params = readControls(loaded.manifest.counts.districts)
  } catch (error) {
    setError(message(error))
    return
  }
  updateUrl()
  clearResult()
  setError(null)

  if (params.districts === 1) {
    assignment = Object.fromEntries(loaded.graph.unitIds.map((unitId) => [unitId, 1]))
    lastStatus = emptyStatus()
    finishPlan(params.seed)
    return
  }

  requestId += 1
  const currentRequest = requestId
  const worker = new ReComWorker()
  recomWorker = worker
  elements.generate.textContent = "Cancel"
  elements.runLabel.textContent = `Running 0 / ${params.steps.toLocaleString()} proposals`
  setFormDisabled(true)

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    if (response.requestId !== 0 && response.requestId !== currentRequest) return
    if (response.type === "ready") return
    if (response.type === "progress") {
      lastStatus = response.status
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
      elements.runLabel.textContent = "Generation failed"
      return
    }
    lastStatus = response.status
    assignment = denseToAssignment(loaded?.graph.unitIds ?? [], response.assignment)
    finishPlan(params.seed)
  }
  worker.onerror = (event) => {
    recomWorker = null
    worker.terminate()
    setFormDisabled(false)
    elements.generate.textContent = "Generate plan"
    setError(event.message || "The ReCom worker failed.")
  }

  const graph = loaded.graph
  const request: WorkerRequest = {
    type: "run",
    requestId: currentRequest,
    graph: {
      edgeCountyCross: graph.edgeCountyCross.slice().buffer,
      neighbors: graph.neighbors.slice().buffer,
      offsets: graph.offsets.slice().buffer,
      populations: graph.populations.slice().buffer,
    },
    params: { ...params, initialAssignment: loaded.initialAssignment.slice().buffer },
  }
  worker.postMessage(request, [
    request.graph.edgeCountyCross,
    request.graph.neighbors,
    request.graph.offsets,
    request.graph.populations,
    request.params.initialAssignment,
  ])
}

function finishPlan(seed: bigint) {
  if (!loaded || !assignment || !lastStatus) return
  viewerMap?.setAssignment(assignment)
  renderScore(lastStatus)
  setProgress(100)
  elements.runLabel.textContent = `${loaded.manifest.counts.districts}-district plan ready`
  elements.mapStatus.textContent = "Generated plan"
  elements.generate.textContent = "Generate again"
  const total = loaded.units.reduce((sum, unit) => sum + unit.popTotal, 0)
  const ideal = total / loaded.manifest.counts.districts
  const populations = new Array<number>(loaded.manifest.counts.districts).fill(0)
  loaded.units.forEach((unit) => {
    const district = assignment?.[unit.unitId] ?? 0
    if (district > 0) populations[district - 1] = (populations[district - 1] ?? 0) + unit.popTotal
  })
  const maxDeviation = Math.max(...populations.map((population) => Math.abs(population - ideal) / ideal))
  elements.population.textContent = Math.round(total).toLocaleString()
  elements.ideal.textContent = Math.round(ideal).toLocaleString()
  elements.deviation.textContent = `${(maxDeviation * 100).toFixed(2)}%`
  elements.resultSeed.textContent = seed.toString()
  elements.resultSection.hidden = false
}

function cancelGeneration() {
  recomWorker?.terminate()
  recomWorker = null
  setFormDisabled(false)
  elements.generate.textContent = assignment ? "Generate again" : "Generate plan"
  if (loaded) elements.runLabel.textContent = assignment ? "Plan ready" : "Ready to generate"
}

function renderScore(status: ChainStatus) {
  elements.scoreGrid.hidden = false
  elements.accepted.textContent = status.stepsAccepted.toLocaleString()
  elements.rejected.textContent = status.stepsRejected.toLocaleString()
  elements.cut.textContent = status.bestScore.cutEdges.toLocaleString()
  elements.splits.textContent = status.bestScore.countySplits.toLocaleString()
}

function clearResult() {
  elements.resultSection.hidden = true
  elements.scoreGrid.hidden = true
  setProgress(0)
  if (viewerMap) viewerMap.setAssignment({})
}

function readControls(districts: number) {
  const seed = BigInt(elements.seed.value)
  if (seed < 0n || seed > 0xffff_ffff_ffff_ffffn) throw new Error("Seed must fit an unsigned 64-bit integer.")
  return {
    districts,
    seed,
    steps: boundedInteger(elements.steps.value, 0, 100_000),
    treeAttempts: boundedInteger(elements.attempts.value, 1, 20),
    popTolerance: Number(elements.tolerance.value) / 100,
    countySurcharge: Number(elements.county.value),
  }
}

function readSetup() {
  const query = new URLSearchParams(location.search)
  const requestedState = query.get("state") ?? "tx"
  return {
    state: stateBySlug.has(requestedState) ? requestedState : "tx",
    seed: /^\d+$/.test(query.get("seed") ?? "") ? query.get("seed") ?? "42" : "42",
    steps: boundedInteger(query.get("steps") ?? "200", 0, 100_000),
    attempts: boundedInteger(query.get("attempts") ?? "3", 1, 20),
    tolerance: boundedNumber(query.get("tolerance"), 0.5, 15, 5),
    county: boundedNumber(query.get("county"), 0, 50, 10),
  }
}

function updateUrl() {
  const url = new URL(location.href)
  url.searchParams.set("state", elements.state.value)
  url.searchParams.set("seed", elements.seed.value)
  url.searchParams.set("steps", elements.steps.value)
  url.searchParams.set("attempts", elements.attempts.value)
  url.searchParams.set("tolerance", elements.tolerance.value)
  url.searchParams.set("county", elements.county.value)
  history.replaceState(null, "", url)
}

async function copySetup() {
  updateUrl()
  await navigator.clipboard.writeText(location.href)
  elements.copy.textContent = "Copied"
  setTimeout(() => { elements.copy.textContent = "Copy setup" }, 1_500)
}

function downloadAssignment() {
  if (!loaded || !assignment || !lastStatus) return
  const payload = {
    algorithm: "recom-core",
    algorithmVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    state: loaded.manifest.state,
    params: {
      seed: elements.seed.value,
      steps: Number(elements.steps.value),
      treeAttempts: Number(elements.attempts.value),
      populationTolerancePercent: Number(elements.tolerance.value),
      countySurcharge: Number(elements.county.value),
    },
    status: lastStatus,
    assignment,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${loaded.manifest.state.slug}-recom-${elements.seed.value}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function syncRangeLabels() {
  elements.toleranceOutput.textContent = `${Number(elements.tolerance.value).toFixed(1)}%`
  elements.countyOutput.textContent = elements.county.value
}

function setControls(enabled: boolean) {
  elements.generate.disabled = !enabled
  elements.copy.disabled = !enabled
}

function setFormDisabled(disabled: boolean) {
  for (const control of [elements.state, elements.seed, elements.steps, elements.attempts, elements.tolerance, elements.county, elements.randomSeed]) {
    control.disabled = disabled
  }
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
  return { stepsAccepted: 0, stepsRejected: 0, currentScore: { cutEdges: 0, countySplits: 0 }, bestScore: { cutEdges: 0, countySplits: 0 } }
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
