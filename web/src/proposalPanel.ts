/**
 * Owns the standalone viewer's map-linked proposal explorer. Inputs are compact trace chunks,
 * one-based checkpoints, and the initial score; outputs provide timeline playback, score-cloud
 * selection, filters, persistent bookmarks, two-plan comparison, sharing, branch assignments, and
 * the responsive map-first chain workbench used to operate those states.
 */
import { ScatterChart, type ScatterSeriesOption } from "echarts/charts"
import type { EChartsOption } from "echarts"
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components"
import {
  init,
  use,
  type EChartsType,
} from "echarts/core"
import { CanvasRenderer } from "echarts/renderers"

import {
  assignmentAtProposal,
  compareProposals,
  filterProposalEvents,
  nearestVisibleProposal,
  proposalAt,
  proposalEventsWithElections,
  type ProposalFilters,
  type ProposalUnitVote,
} from "./proposalExplorer"
import type { PlanScore, ProposalTrace, ProposalTraceChunk } from "./types"

use([AriaComponent, CanvasRenderer, DataZoomComponent, GridComponent, ScatterChart, TooltipComponent])

const playbackDelayMS = 180
const scoreCloudColors = {
  accent: "#3f5870",
  border: "#ddd7cd",
  borderStrong: "#c9c2b8",
  card: "#fdfbf7",
  faint: "#8a847b",
  frontier: "#a35216",
  frontierBorder: "#7c3a0e",
  ink: "#282522",
}

export type ProposalPanelData = {
  chunks: ProposalTraceChunk[]
  districtCount: number
  frontier: PlanScore[]
  initialAssignment: Uint16Array
  initialScore: PlanScore
  selectedProposal?: number
  storageKey: string
  unitVotes: ProposalUnitVote[]
}

export type ProposalPanelCallbacks = {
  onBranch: (assignment: Uint16Array, proposal: number) => void
  onCompare: (assignment: Uint16Array | null) => void
  onSelect: (assignment: Uint16Array, score: PlanScore, proposal: number) => void
}

const defaultFilters: ProposalFilters = {
  acceptedOnly: false,
  frontierOnly: false,
  maxCountyFragments: null,
  maxDeviationPercent: null,
  minDemSeats: null,
  maxDemSeats: null,
}

const proposalIcons = {
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>',
  branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M8 7.5c5 0 4-1.5 8-1.5M8 16.5c5 0 4-8.5 8-8.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  compare: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>',
  previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></svg>',
}

export class ProposalPanel {
  private readonly root: HTMLElement
  private data: ProposalPanelData | null = null
  private events: ProposalTrace[] = []
  private filters = { ...defaultFilters }
  private selectedProposal = 0
  private compareProposal: number | null = null
  private bookmarks: number[] = []
  private playback: number | null = null
  private playbackSpeed = 1
  private scoreCloud: EChartsType | null = null

  constructor(private readonly callbacks: ProposalPanelCallbacks) {
    const root = document.createElement("aside")
    root.className = "proposal-explorer"
    root.setAttribute("role", "dialog")
    root.setAttribute("aria-label", "Proposal explorer")
    root.hidden = true
    root.innerHTML = proposalPanelMarkup()
    document.querySelector(".viewer-shell")?.append(root)
    this.root = root
    this.bind()
  }

  open(data: ProposalPanelData) {
    this.data = data
    const retained = new Set(data.frontier.map(scoreKey))
    this.events = proposalEventsWithElections(
      data.initialAssignment,
      data.chunks,
      data.unitVotes,
      data.districtCount,
    ).map((event) => ({
      ...event,
      frontierRetained: retained.has(scoreKey(event.score)),
    }))
    this.selectedProposal = Math.max(
      0,
      Math.min(data.selectedProposal ?? this.events.at(-1)?.proposal ?? 0, this.maximum()),
    )
    this.compareProposal = null
    this.filters = { ...defaultFilters }
    this.bookmarks = this.loadBookmarks()
    this.root.hidden = false
    this.render()
    this.select(this.selectedProposal)
  }

  close() {
    this.stopPlayback()
    this.callbacks.onCompare(null)
    this.root.hidden = true
  }

  reset() {
    this.close()
    this.data = null
    this.events = []
    this.selectedProposal = 0
    this.compareProposal = null
  }

  isOpen() {
    return !this.root.hidden
  }

  private bind() {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]")
      if (!button) return
      const action = button.dataset.action
      if (action === "close") this.close()
      else if (action === "previous") this.select(nearestVisibleProposal(this.visible(), this.selectedProposal, -1))
      else if (action === "next") this.select(nearestVisibleProposal(this.visible(), this.selectedProposal, 1))
      else if (action === "play") this.togglePlayback()
      else if (action === "reset-filters") this.resetFilters()
      else if (action === "clear-compare") this.setCompare(null)
      else if (action === "compare") this.setCompare(this.selectedProposal)
      else if (action === "bookmark") this.toggleBookmark()
      else if (action === "share") void this.share()
      else if (action === "branch") this.branch()
    })
    this.element<HTMLInputElement>("[data-proposal-range]").addEventListener("input", (event) => {
      this.select(Number((event.target as HTMLInputElement).value))
    })
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-filter]")) {
      input.addEventListener("input", () => {
        this.filters = {
          acceptedOnly: this.element<HTMLInputElement>('[data-filter="accepted"]').checked,
          frontierOnly: this.element<HTMLInputElement>('[data-filter="frontier"]').checked,
          maxCountyFragments: nullableNumber(this.element<HTMLInputElement>('[data-filter="fragments"]').value),
          maxDeviationPercent: nullableNumber(this.element<HTMLInputElement>('[data-filter="deviation"]').value),
          minDemSeats: nullableNumber(this.element<HTMLInputElement>('[data-filter="min-dem"]').value),
          maxDemSeats: nullableNumber(this.element<HTMLInputElement>('[data-filter="max-dem"]').value),
        }
        this.render()
      })
    }
    this.element<HTMLSelectElement>("[data-playback-speed]").addEventListener("change", (event) => {
      const speed = Number((event.target as HTMLSelectElement).value)
      if (!Number.isFinite(speed) || speed <= 0) return
      this.playbackSpeed = speed
      if (this.playback !== null) this.startPlayback()
    })
    const cloud = this.element("[data-score-cloud]")
    new ResizeObserver(() => this.scoreCloud?.resize()).observe(cloud)
  }

  private select(proposal: number) {
    const data = this.data
    if (!data) return
    this.selectedProposal = Math.max(0, Math.min(this.maximum(), Math.floor(proposal)))
    const selected = proposalAt(data.chunks, this.selectedProposal)
    const assignment = assignmentAtProposal(
      data.initialAssignment,
      data.chunks,
      this.selectedProposal,
    )
    this.callbacks.onSelect(
      assignment,
      selected?.score ?? data.initialScore,
      this.selectedProposal,
    )
    const url = new URL(location.href)
    url.searchParams.set("proposal", String(this.selectedProposal))
    history.replaceState(null, "", url)
    this.render()
  }

  private visible() {
    return filterProposalEvents(this.events, this.filters)
  }

  private render() {
    const data = this.data
    if (!data) return
    const event = proposalAt(data.chunks, this.selectedProposal)
    const score = event?.score ?? data.initialScore
    const accepted = this.events.filter((proposal) => proposal.outcome === "accepted").length
    this.text("[data-proposal-summary]", this.events.length.toLocaleString() + " attempts · " + accepted.toLocaleString() + " accepted · " + (this.events.length - accepted).toLocaleString() + " rejected")
    this.text("[data-proposal-position]", this.selectedProposal.toLocaleString() + " / " + this.maximum().toLocaleString())
    const range = this.element<HTMLInputElement>("[data-proposal-range]")
    range.max = String(this.maximum())
    range.value = String(this.selectedProposal)
    range.style.setProperty("--fill", `${this.maximum() === 0 ? 0 : this.selectedProposal / this.maximum() * 100}%`)
    const outcome = this.element("[data-proposal-outcome]")
    outcome.className = "proposal-outcome proposal-outcome--" + (event?.outcome ?? "initial")
    outcome.textContent = event ? outcomeLabel(event) : "Initial plan"
    this.text("[data-proposal-title]", "Proposal " + this.selectedProposal.toLocaleString())
    this.text("[data-proposal-detail]", event?.outcome === "accepted"
      ? event.changeCount.toLocaleString() + " units changed" + (event.frontierChanged ? " · entered frontier" : "")
      : event ? rejectionDescription(event) : "Starting assignment before the first proposal.")
    this.text("[data-visible-count]", this.visible().length.toLocaleString() + " visible")
    this.text("[data-score-kind]", event?.frontierRetained ? "Frontier" : "Chain")
    this.element("[data-score-metrics]").innerHTML = metricHtml([
      ["Weighted cut", score.weightedCut.toLocaleString()],
      ["County fragments", score.countyFragments.toLocaleString()],
      ["County splits", score.countySplits.toLocaleString()],
      ["Max deviation", (score.maxDeviationPpm / 10_000).toFixed(2) + "%"],
      ["D seats", event?.demSeats?.toLocaleString() ?? "—"],
      ["R seats", event?.repSeats?.toLocaleString() ?? "—"],
    ])
    this.renderComparison(score)
    this.renderBookmarks()
    this.drawCloud()
  }

  private renderComparison(currentScore: PlanScore) {
    const data = this.data
    const section = this.element<HTMLElement>("[data-comparison]")
    if (!data || this.compareProposal === null) {
      section.hidden = true
      return
    }
    const compareEvent = proposalAt(data.chunks, this.compareProposal)
    const comparison = compareProposals(
      assignmentAtProposal(data.initialAssignment, data.chunks, this.compareProposal),
      compareEvent?.score ?? data.initialScore,
      assignmentAtProposal(data.initialAssignment, data.chunks, this.selectedProposal),
      currentScore,
    )
    section.hidden = false
    this.text("[data-comparison-title]", "Proposal " + this.compareProposal.toLocaleString() + " → " + this.selectedProposal.toLocaleString())
    this.element("[data-comparison-metrics]").innerHTML = metricHtml([
      ["Changed units", comparison.changedUnits.toLocaleString()],
      ["Weighted cut Δ", signed(comparison.scoreDelta.weightedCut)],
      ["County fragments Δ", signed(comparison.scoreDelta.countyFragments)],
      ["Deviation Δ", signed(comparison.scoreDelta.maxDeviationPpm / 10_000, 2) + "%"],
    ])
  }

  private renderBookmarks() {
    this.text("[data-bookmark-count]", String(this.bookmarks.length))
    const container = this.element("[data-bookmarks]")
    container.replaceChildren()
    if (this.bookmarks.length === 0) {
      const empty = document.createElement("small")
      empty.textContent = "No bookmarked proposals yet."
      container.append(empty)
    } else {
      for (const proposal of this.bookmarks) {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = "P" + proposal.toLocaleString()
        button.setAttribute("aria-pressed", String(proposal === this.selectedProposal))
        button.addEventListener("click", () => this.select(proposal))
        container.append(button)
      }
    }
    this.setActionContent(
      '[data-action="bookmark"]',
      proposalIcons.bookmark,
      this.bookmarks.includes(this.selectedProposal) ? "Bookmarked" : "Bookmark",
    )
  }

  private drawCloud() {
    const events = this.visible().filter((event) => event.outcome === "accepted")
    const groups = {
      accepted: events.filter((event) => !event.frontierRetained && event.proposal !== this.selectedProposal && event.proposal !== this.compareProposal),
      frontier: events.filter((event) => event.frontierRetained && event.proposal !== this.selectedProposal && event.proposal !== this.compareProposal),
      compared: events.filter((event) => event.proposal === this.compareProposal && event.proposal !== this.selectedProposal),
      selected: events.filter((event) => event.proposal === this.selectedProposal),
    }
    const option: EChartsOption = {
      animationDuration: 180,
      animationDurationUpdate: 120,
      aria: {
        enabled: true,
        decal: { show: false },
        description: "Accepted proposal scores by weighted cut and county fragments.",
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "inside", yAxisIndex: 0, filterMode: "none" },
      ],
      grid: { top: 15, right: 12, bottom: 30, left: 43, containLabel: false },
      series: [
        scoreCloudSeries("Accepted", groups.accepted, {
          color: scoreCloudColors.accent,
          opacity: 0.5,
        }, 5),
        scoreCloudSeries("Frontier", groups.frontier, {
          borderColor: scoreCloudColors.frontierBorder,
          borderWidth: 1,
          color: scoreCloudColors.frontier,
          opacity: 0.9,
        }, 7),
        scoreCloudSeries("Compared", groups.compared, {
          borderColor: scoreCloudColors.ink,
          borderWidth: 1.5,
          color: scoreCloudColors.card,
          opacity: 1,
        }, 10),
        scoreCloudSeries("Selected", groups.selected, {
          borderColor: scoreCloudColors.card,
          borderWidth: 1.5,
          color: scoreCloudColors.ink,
          opacity: 1,
        }, 11),
      ],
      tooltip: {
        appendToBody: true,
        backgroundColor: scoreCloudColors.ink,
        borderWidth: 0,
        confine: true,
        extraCssText: "border-radius:3px;box-shadow:0 8px 24px rgb(45 38 28 / 18%);",
        formatter: scoreCloudTooltip,
        padding: [7, 9],
        textStyle: {
          color: scoreCloudColors.card,
          fontFamily: '"Geist Mono Variable", monospace',
          fontSize: 10,
          lineHeight: 16,
        },
        trigger: "item",
      },
      xAxis: {
        axisLabel: { color: scoreCloudColors.faint, fontFamily: '"Geist Mono Variable", monospace', fontSize: 8 },
        axisLine: { lineStyle: { color: scoreCloudColors.borderStrong } },
        axisTick: { show: false },
        name: "WEIGHTED CUT",
        nameGap: 18,
        nameLocation: "middle",
        nameTextStyle: { color: scoreCloudColors.faint, fontFamily: '"Geist Mono Variable", monospace', fontSize: 8 },
        scale: true,
        splitLine: { show: false },
        type: "value",
      },
      yAxis: {
        axisLabel: { color: scoreCloudColors.faint, fontFamily: '"Geist Mono Variable", monospace', fontSize: 8 },
        axisLine: { lineStyle: { color: scoreCloudColors.borderStrong } },
        axisTick: { show: false },
        name: "FRAGMENTS",
        nameGap: 8,
        nameTextStyle: { color: scoreCloudColors.faint, fontFamily: '"Geist Mono Variable", monospace', fontSize: 8 },
        scale: true,
        splitLine: { lineStyle: { color: scoreCloudColors.border, opacity: 0.6 } },
        type: "value",
      },
    }
    this.ensureScoreCloud().setOption(option, { lazyUpdate: true, notMerge: true })
  }

  private ensureScoreCloud() {
    if (this.scoreCloud) return this.scoreCloud
    this.scoreCloud = init(this.element("[data-score-cloud]"), undefined, { renderer: "canvas" })
    this.scoreCloud.on("click", (parameters) => {
      const values = scoreCloudValues(parameters.value)
      if (values) this.select(values.proposal)
    })
    return this.scoreCloud
  }

  private setCompare(proposal: number | null) {
    const data = this.data
    this.compareProposal = proposal
    this.callbacks.onCompare(
      data && proposal !== null
        ? assignmentAtProposal(data.initialAssignment, data.chunks, proposal)
        : null,
    )
    this.render()
  }

  private toggleBookmark() {
    this.bookmarks = this.bookmarks.includes(this.selectedProposal)
      ? this.bookmarks.filter((proposal) => proposal !== this.selectedProposal)
      : [...this.bookmarks, this.selectedProposal].sort((left, right) => left - right)
    const data = this.data
    if (data) {
      try {
        localStorage.setItem("recom-proposals:" + data.storageKey, JSON.stringify(this.bookmarks))
      } catch {
        // Session bookmarks remain usable when persistent storage is unavailable.
      }
    }
    this.renderBookmarks()
  }

  private loadBookmarks() {
    const data = this.data
    if (!data) return []
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("recom-proposals:" + data.storageKey) ?? "[]")
      return Array.isArray(parsed)
        ? parsed.filter((value): value is number => Number.isInteger(value) && value >= 0 && value <= this.maximum())
        : []
    } catch {
      return []
    }
  }

  private togglePlayback() {
    if (this.playback !== null) {
      this.stopPlayback()
      return
    }
    this.startPlayback()
  }

  private startPlayback() {
    if (this.playback !== null) window.clearInterval(this.playback)
    this.setActionContent('[data-action="play"]', proposalIcons.pause, "Pause")
    this.playback = window.setInterval(() => {
      const next = nearestVisibleProposal(this.visible(), this.selectedProposal, 1)
      if (next === this.selectedProposal) this.stopPlayback()
      else this.select(next)
    }, playbackDelayMS / this.playbackSpeed)
  }

  private stopPlayback() {
    if (this.playback !== null) window.clearInterval(this.playback)
    this.playback = null
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="play"]')
    if (button) this.setActionContent('[data-action="play"]', proposalIcons.play, "Play")
  }

  private resetFilters() {
    this.filters = { ...defaultFilters }
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-filter]")) {
      if (input.type === "checkbox") input.checked = false
      else input.value = ""
    }
    this.render()
  }

  private async share() {
    const url = new URL(location.href)
    url.searchParams.set("proposal", String(this.selectedProposal))
    await navigator.clipboard.writeText(url.toString())
    this.setActionContent('[data-action="share"]', proposalIcons.check, "Copied")
    window.setTimeout(() => {
      this.setActionContent('[data-action="share"]', proposalIcons.share, "Share")
    }, 1_500)
  }

  private branch() {
    const data = this.data
    if (!data) return
    this.callbacks.onBranch(
      assignmentAtProposal(data.initialAssignment, data.chunks, this.selectedProposal),
      this.selectedProposal,
    )
  }

  private maximum() {
    return this.events.at(-1)?.proposal ?? 0
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string) {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error("Proposal explorer is missing " + selector)
    return element
  }

  private text(selector: string, value: string) {
    this.element(selector).textContent = value
  }

  private setActionContent(selector: string, icon: string, label: string) {
    this.element<HTMLButtonElement>(selector).innerHTML = icon + "<span>" + label + "</span>"
  }
}

function proposalPanelMarkup() {
  return `
    <header class="proposal-explorer__header">
      <div class="proposal-explorer__identity">
        <span class="proposal-explorer__mark">PX</span>
        <div><span>RECOM-CORE / CHAIN LAB</span><h2>Proposal explorer</h2><p data-proposal-summary></p></div>
      </div>
      <button type="button" data-action="close" aria-label="Close proposal explorer">${proposalIcons.close}</button>
    </header>
    <div class="proposal-explorer__body">
      <section class="proposal-explorer__timeline">
        ${sectionHeading("01", "Chain timeline", '<span data-proposal-position></span>')}
        <input data-proposal-range aria-label="Selected proposal" type="range" min="0" value="0">
        <div class="proposal-explorer__transport">
          <button type="button" data-action="previous" aria-label="Previous filtered proposal">${proposalIcons.previous}</button>
          <button type="button" data-action="play">${proposalIcons.play}<span>Play</span></button>
          <button type="button" data-action="next" aria-label="Next filtered proposal">${proposalIcons.next}</button>
          <select data-playback-speed aria-label="Playback speed" title="Playback speed">
            <option value="0.5">0.5× speed</option>
            <option value="1" selected>1× speed</option>
            <option value="2">2× speed</option>
            <option value="4">4× speed</option>
          </select>
        </div>
        <div class="proposal-explorer__event"><span class="proposal-outcome" data-proposal-outcome></span><strong data-proposal-title></strong><small data-proposal-detail></small></div>
      </section>
      <section class="proposal-explorer__metrics">
        ${sectionHeading("02", "Selected score", '<span data-score-kind></span>')}
        <div data-score-metrics></div>
      </section>
      <section class="proposal-explorer__cloud">
        ${sectionHeading("03", "Score cloud", '<span data-visible-count></span>')}
        <div data-score-cloud tabindex="0" role="img" aria-label="Accepted proposal score cloud. Horizontal position is weighted cut and vertical position is county fragments. Scroll to zoom and click a point to select it."></div>
        <div class="proposal-explorer__cloud-legend"><span><i></i>Accepted</span><span><i class="frontier"></i>Frontier</span><span><i class="compared"></i>Compared</span><span><i class="selected"></i>Selected</span></div>
      </section>
      <section class="proposal-explorer__filters">
        ${sectionHeading("04", "Filters", '<button type="button" data-action="reset-filters">Reset</button>')}
        <div><label><input data-filter="accepted" type="checkbox"> Accepted only</label><label><input data-filter="frontier" type="checkbox"> Frontier only</label><label><span>Fragments ≤</span><input data-filter="fragments" type="number" min="0" placeholder="Any"></label><label><span>Deviation ≤ %</span><input data-filter="deviation" type="number" min="0" step="0.1" placeholder="Any"></label><label><span>D seats ≥</span><input data-filter="min-dem" type="number" min="0" placeholder="Any"></label><label><span>D seats ≤</span><input data-filter="max-dem" type="number" min="0" placeholder="Any"></label></div>
      </section>
      <section class="proposal-explorer__comparison" data-comparison hidden>
        ${sectionHeading("05", "Compare", '<button type="button" data-action="clear-compare">Clear</button>')}
        <p data-comparison-title></p><div data-comparison-metrics></div>
      </section>
      <section class="proposal-explorer__bookmarks">
        ${sectionHeading("06", "Bookmarks", '<span data-bookmark-count></span>')}
        <div data-bookmarks></div>
      </section>
    </div>
    <footer class="proposal-explorer__actions">
      <button type="button" data-action="bookmark">${proposalIcons.bookmark}<span>Bookmark</span></button>
      <button type="button" data-action="compare">${proposalIcons.compare}<span>Pin compare</span></button>
      <button type="button" data-action="share">${proposalIcons.share}<span>Share</span></button>
      <button class="proposal-explorer__branch" type="button" data-action="branch">${proposalIcons.branch}<span>Branch here</span></button>
    </footer>`
}

function sectionHeading(index: string, title: string, action: string) {
  return `<div class="proposal-explorer__section-heading"><div><span>${index}</span><h3>${title}</h3></div>${action}</div>`
}

function metricHtml(items: Array<[string, string]>) {
  return items.map(([label, value]) => "<div><span>" + label + "</span><strong>" + value + "</strong></div>").join("")
}

function scoreCloudSeries(
  name: string,
  events: ProposalTrace[],
  itemStyle: NonNullable<ScatterSeriesOption["itemStyle"]>,
  symbolSize: number,
): ScatterSeriesOption {
  return {
    type: "scatter",
    name,
    data: events.map((event) => ({
      name: "Proposal " + event.proposal.toLocaleString(),
      value: [
        event.score.weightedCut,
        event.score.countyFragments,
        event.proposal,
        event.score.maxDeviationPpm,
        event.demSeats ?? -1,
        event.repSeats ?? -1,
      ],
    })),
    dimensions: ["weightedCut", "countyFragments", "proposal", "maxDeviationPpm", "demSeats", "repSeats"],
    emphasis: { focus: "self", scale: 1.6 },
    encode: { x: "weightedCut", y: "countyFragments" },
    itemStyle,
    symbolSize,
  }
}

type ScoreCloudValues = {
  countyFragments: number
  demSeats: number
  maxDeviationPpm: number
  proposal: number
  repSeats: number
  weightedCut: number
}

function scoreCloudValues(value: unknown): ScoreCloudValues | null {
  if (!Array.isArray(value) || value.length < 6) return null
  const values = value.map(Number)
  if (values.some((item) => !Number.isFinite(item))) return null
  return {
    weightedCut: values[0] ?? 0,
    countyFragments: values[1] ?? 0,
    proposal: values[2] ?? 0,
    maxDeviationPpm: values[3] ?? 0,
    demSeats: values[4] ?? -1,
    repSeats: values[5] ?? -1,
  }
}

function scoreCloudTooltip(parameters: unknown) {
  const parameter = Array.isArray(parameters) ? parameters[0] : parameters
  const values = scoreCloudValues(
    typeof parameter === "object" && parameter !== null && "value" in parameter
      ? parameter.value
      : null,
  )
  if (!values) return "Proposal score unavailable"
  const seats = values.demSeats < 0 || values.repSeats < 0
    ? "—"
    : `${values.demSeats.toLocaleString()} D · ${values.repSeats.toLocaleString()} R`
  return `<strong>Proposal ${values.proposal.toLocaleString()}</strong><br>`
    + `Weighted cut&nbsp;&nbsp;${values.weightedCut.toLocaleString()}<br>`
    + `Fragments&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${values.countyFragments.toLocaleString()}<br>`
    + `Max deviation&nbsp;&nbsp;${(values.maxDeviationPpm / 10_000).toFixed(2)}%<br>`
    + `Seats&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${seats}`
}

function outcomeLabel(event: ProposalTrace) {
  if (event.outcome === "accepted") return "Accepted"
  if (event.outcome === "noEligibleBoundary") return "Rejected · frozen boundary"
  if (event.outcome === "noSpanningTree") return "Rejected · disconnected merge"
  return "Rejected · no balanced cut"
}

function rejectionDescription(event: ProposalTrace) {
  if (event.outcome === "noEligibleBoundary") return "No eligible unfrozen district boundary was available."
  if (event.outcome === "noSpanningTree") return "Tree attempts could not connect the selected district pair."
  return "No tree edge produced two districts inside the population tolerance."
}

function nullableNumber(value: string) {
  if (value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null
}

function signed(value: number, digits = 0) {
  return (value > 0 ? "+" : "") + value.toFixed(digits)
}

function scoreKey(score: PlanScore) {
  return score.weightedCut + ":" + score.countyFragments + ":" + score.maxDeviationPpm
}
