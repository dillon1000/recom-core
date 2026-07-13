/**
 * Owns the standalone public viewer UI. Inputs are URL-backed controls and the
 * 50-state data loader; outputs are deterministic plans, live map updates,
 * shareable setup URLs, and portable JSON assignments. Generation is always
 * local and unsigned—there is no account, upload, or server compute path.
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
import { assignmentWithinTolerance, denseToAssignment } from "./graph"
import { ViewerMap } from "./map"
import type { MapColorMode } from "./mapColors"
import ReComWorker from "./recom.worker?worker"
import type {
  AssignmentMap,
  ChainStatus,
  PlanScore,
  ViewerResolution,
  WorkerRequest,
  WorkerResponse,
} from "./types"

const app = document.querySelector<HTMLElement>("#app")
if (!app) throw new Error("The viewer root is missing.")

app.innerHTML = `
  <div class="viewer-shell">
    <aside class="viewer-sidebar">
      <header class="viewer-header">
        <div class="viewer-eyebrow"><span class="viewer-mark">AR</span><span>RECOM-CORE / PUBLIC VIEWER</span></div>
        <h1>Auto-redistricter</h1>
        <p>Generate contiguous, population-balanced congressional plans from census block groups or authentic precinct boundaries. No account, upload, or server compute.</p>
      </header>

      <section class="viewer-section" aria-labelledby="dataset-heading">
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
          <div class="metric"><span>Weighted cut</span><strong id="cut-value">0</strong></div>
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
        <button class="button button--full button--analytics" id="open-analytics" type="button">Open detailed analytics</button>
      </section>

      <footer class="viewer-footer"><span>MIT / DETERMINISTIC WASM</span><a href="https://github.com/dillon1000/recom-core">SOURCE</a></footer>
    </aside>
    <section class="viewer-map" aria-label="Generated district map">
      <div id="map" class="viewer-map__canvas"></div>
      <div class="map-label"><strong id="map-state">Loading</strong><span id="map-status">Authentic geography</span></div>
      <div class="map-color-control">
        <span>Map color</span>
        <div role="group" aria-label="Map color mode"><button type="button" data-map-color="district" aria-pressed="true">Districts</button><button type="button" data-map-color="partisanship" aria-pressed="false" disabled>Partisan</button></div>
        <div class="partisan-legend" id="partisan-legend" role="img" aria-label="Each generated district colored continuously by its aggregate 2024 presidential two-party margin from Republican plus 30 through even to Democratic plus 30" hidden><i></i><div><span>R +30</span><span>Even</span><span>D +30</span></div></div>
      </div>
      <div class="map-hover" id="map-hover" hidden></div>
    </section>
    <aside class="analytics-panel" id="analytics-panel" role="dialog" aria-label="Generated plan analytics" hidden>
      <header class="analytics-header"><div><span>PLAN OBSERVATORY</span><h2>Generated plan analytics</h2><p id="analytics-subtitle"></p></div><button id="close-analytics" type="button" aria-label="Close analytics">×</button></header>
      <nav class="analytics-tabs" id="analytics-tabs" aria-label="Analytics views">
        <button data-tab="overview" aria-current="page">Overview</button><button data-tab="population">Population</button><button data-tab="demographics">Demographics</button><button data-tab="elections">Elections</button><button data-tab="districts">Districts</button>
      </nav>
      <div class="analytics-body" id="analytics-body"></div>
    </aside>
  </div>
`

const elements = {
  accepted: get("accepted-value"), attempts: input("attempts"), copy: button("copy"),
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
  partisanLegend: get("partisan-legend"),
  resolutionButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-resolution]")),
  resolutionHelp: get("resolution-help"),
  resultSeed: get("result-seed"), runLabel: get("run-label"), runPercent: get("run-percent"),
  runProgress: get("run-progress"), scoreGrid: get("score-grid"), seed: input("seed"),
  splits: get("splits-value"), state: select("state-select"), steps: input("steps"),
  tolerance: input("tolerance"), toleranceOutput: get("tolerance-output"), units: get("units-value"),
  unitsLabel: get("units-label"),
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
elements.tolerance.value = String(setup.tolerance)
elements.county.value = String(setup.county)
syncRangeLabels()

let loaded: LoadedState | null = null
let viewerMap: ViewerMap | null = null
let recomWorker: Worker | null = null
let assignment: AssignmentMap | null = null
let bestAssignment: AssignmentMap | null = null
let frontierScores: PlanScore[] = []
let lastStatus: ChainStatus | null = null
let analytics: PlanAnalytics | null = null
let unitLookup = new Map<string, LoadedState["units"][number]>()
let requestId = 0

elements.state.addEventListener("change", () => void loadSelectedState())
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
  else void generate()
})
elements.copy.addEventListener("click", () => void copySetup())
elements.download.addEventListener("click", downloadAssignment)
elements.openAnalytics.addEventListener("click", () => {
  if (analytics) elements.analyticsPanel.hidden = false
})
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
  if (event.key === "Escape") elements.analyticsPanel.hidden = true
})

void loadSelectedState()

async function loadSelectedState() {
  const resolution = currentResolution()
  const selectedDataset = datasetSlug(elements.state.value, resolution)
  cancelGeneration()
  loaded = null
  assignment = null
  bestAssignment = null
  frontierScores = []
  lastStatus = null
  analytics = null
  unitLookup = new Map()
  viewerMap?.destroy()
  viewerMap = null
  activateMapColorMode("district")
  clearResult()
  setError(null)
  setControls(false)
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
    elements.runLabel.textContent = "Ready to generate"
    elements.generationNote.textContent = bundle.manifest.counts.districts === 1
      ? `${bundle.manifest.state.stateName} is at-large, so generation assigns every ${resolution === "precinct" ? "precinct" : "block group"} to District 1.`
      : `ReCom reuses the published ${resolutionLabel(resolution).toLowerCase()} reference assignment when it satisfies the selected tolerance. Otherwise it deterministically seeds a balanced contiguous plan before advancing the proposal chain.`
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
  analytics = null
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
    bestAssignment = denseToAssignment(loaded?.graph.unitIds ?? [], response.bestAssignment)
    frontierScores = response.frontier
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
      ...(graph.edgeWeights ? { edgeWeights: graph.edgeWeights.slice().buffer } : {}),
      neighbors: graph.neighbors.slice().buffer,
      offsets: graph.offsets.slice().buffer,
      populations: graph.populations.slice().buffer,
    },
    params: {
      ...params,
      ...(assignmentWithinTolerance(
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

function finishPlan(seed: bigint) {
  if (!loaded || !assignment || !lastStatus) return
  analytics = computeAnalytics(
    loaded.units,
    assignment,
    loaded.manifest.counts.districts,
    lastStatus,
  )
  viewerMap?.setAssignment(
    assignment,
    analytics.districts.map((district) => district.election.demShare),
  )
  const partisanControl = elements.mapColorButtons.find(
    (control) => control.dataset.mapColor === "partisanship",
  )
  if (partisanControl) partisanControl.disabled = false
  renderScore(lastStatus)
  setProgress(100)
  elements.runLabel.textContent = `${loaded.manifest.counts.districts}-district plan ready`
  elements.mapStatus.textContent = `${loaded.manifest.editUnit === "precinct" ? "Precincts" : "Block groups"} · generated plan`
  elements.generate.textContent = "Generate again"
  elements.population.textContent = Math.round(analytics.totalPopulation).toLocaleString()
  elements.ideal.textContent = Math.round(analytics.idealPopulation).toLocaleString()
  elements.deviation.textContent = `${analytics.maxDeviationPercent.toFixed(2)}%`
  elements.resultSeed.textContent = seed.toString()
  elements.resultSection.hidden = false
  elements.analyticsSubtitle.textContent = `${analytics.districts.length} districts · ${analytics.totalUnits.toLocaleString()} ${loaded.manifest.editUnit === "precinct" ? "precincts" : "block groups"} · census and 2024 presidential diagnostics`
  renderAnalytics("overview", analytics)
  elements.analyticsPanel.hidden = false
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
  elements.cut.textContent = status.currentScore.weightedCut.toLocaleString()
  elements.splits.textContent = status.currentScore.countySplits.toLocaleString()
}

function clearResult() {
  elements.resultSection.hidden = true
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
    tolerance: boundedNumber(query.get("tolerance"), 0.5, 15, 5),
    county: boundedNumber(query.get("county"), 0, 50, 10),
  }
}

function updateUrl() {
  const url = new URL(location.href)
  url.searchParams.set("state", elements.state.value)
  url.searchParams.set("resolution", currentResolution())
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
    resolution: currentResolution(),
    state: loaded.manifest.state,
    params: {
      seed: elements.seed.value,
      steps: Number(elements.steps.value),
      treeAttempts: Number(elements.attempts.value),
      populationTolerancePercent: Number(elements.tolerance.value),
      countySurcharge: Number(elements.county.value),
    },
    status: lastStatus,
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
  for (const control of [elements.state, elements.seed, elements.steps, elements.attempts, elements.tolerance, elements.county, elements.randomSeed]) {
    control.disabled = disabled
  }
  for (const control of elements.resolutionButtons) control.disabled = disabled
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
  return { stepsAccepted: 0, stepsRejected: 0, currentScore: score, bestScore: score, frontierSize: 1 }
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
