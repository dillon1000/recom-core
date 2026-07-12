/**
 * Renders authentic state PMTiles with generated district feature state. Inputs
 * are public manifest layers and one-based unit assignments; outputs are a
 * bounded interactive map whose fills and live district edges update without
 * rebuilding sources. The public data origin is configured in data.ts.
 */
import maplibregl, { type ExpressionSpecification, type FillLayerSpecification } from "maplibre-gl"
import { Protocol } from "pmtiles"
import "maplibre-gl/dist/maplibre-gl.css"

import { publicAssetUrl } from "./data"
import type { AssignmentMap, Manifest, ManifestLayer } from "./types"

const fineSource = "units"
const coarseSource = "units-coarse"
const edgeSource = "district-edges"
let protocolInstalled = false

export class ViewerMap {
  private assignment: AssignmentMap = {}
  private readonly map: maplibregl.Map
  private animationFrame: number | null = null

  constructor(container: HTMLElement, private readonly manifest: Manifest) {
    installProtocol()
    this.map = new maplibregl.Map({
      attributionControl: false,
      bounds: manifest.state.bounds,
      container,
      fitBoundsOptions: { padding: 28 },
      maxBounds: paddedBounds(manifest.state.bounds),
      maxZoom: 13,
      minZoom: 1,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "background", type: "background", paint: { "background-color": "#eeeae3" } }],
      },
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    this.map.on("load", () => {
      this.installUnitLayers()
      this.installEdgeLayer()
      this.scheduleSync()
    })
    this.map.on("sourcedata", () => this.scheduleSync())
    this.map.on("moveend", () => this.scheduleSync())
  }

  setAssignment(assignment: AssignmentMap) {
    this.assignment = assignment
    if (this.map.isStyleLoaded()) this.scheduleSync()
  }

  destroy() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.map.remove()
  }

  private installUnitLayers() {
    const archive = this.manifest.tiles.pmtiles
    const fine = archive.layers.units
    this.addUnitSource(fineSource, archive.redistricting, fine)
    this.addUnitFill("units-fill", fineSource, fine, fine.minzoom)
    this.map.addLayer({
      id: "unit-lines",
      type: "line",
      source: fineSource,
      "source-layer": fine.sourceLayer,
      minzoom: Math.max(fine.minzoom, 7),
      paint: {
        "line-color": "#fffdf8",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.08, 11, 0.45],
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.15, 11, 0.7],
      },
    })

    const coarse = archive.coarse
    if (!coarse) return
    this.addUnitSource(coarseSource, coarse.redistricting, coarse.layers.units)
    this.addUnitFill("units-coarse-fill", coarseSource, coarse.layers.units, undefined, fine.minzoom)
  }

  private addUnitSource(id: string, rawUrl: string, layer: ManifestLayer) {
    this.map.addSource(id, {
      type: "vector",
      url: `pmtiles://${publicAssetUrl(this.manifest.state.slug, rawUrl)}`,
      bounds: this.manifest.state.bounds,
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
      promoteId: layer.promoteId ?? "unitId",
    })
  }

  private addUnitFill(
    id: string,
    source: string,
    layer: ManifestLayer,
    minzoom?: number,
    maxzoom?: number,
  ) {
    this.map.addLayer({
      id,
      type: "fill",
      source,
      "source-layer": layer.sourceLayer,
      minzoom,
      maxzoom,
      paint: unitPaint(this.manifest.counts.districts),
    })
  }

  private installEdgeLayer() {
    const edges = this.manifest.tiles.reference?.liveDistrictEdges
    if (!edges) return
    this.map.addSource(edgeSource, {
      type: "vector",
      url: `pmtiles://${publicAssetUrl(this.manifest.state.slug, edges.url)}`,
      bounds: this.manifest.state.bounds,
      minzoom: edges.minzoom,
      maxzoom: edges.maxzoom,
      promoteId: edges.promoteId ?? "edgeId",
    })
    this.map.addLayer({
      id: "district-edge-lines",
      type: "line",
      source: edgeSource,
      "source-layer": edges.sourceLayer,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#171717",
        "line-opacity": ["case", ["boolean", ["feature-state", "show"], false], 0.82, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 9, 2.2, 13, 3],
      },
    })
  }

  private scheduleSync() {
    if (this.animationFrame !== null) return
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null
      this.syncUnits(fineSource, this.manifest.tiles.pmtiles.layers.units.sourceLayer)
      const coarse = this.manifest.tiles.pmtiles.coarse
      if (coarse) this.syncUnits(coarseSource, coarse.layers.units.sourceLayer)
      this.syncEdges()
    })
  }

  private syncUnits(source: string, sourceLayer: string) {
    if (!this.map.getSource(source)) return
    const seen = new Set<string>()
    for (const feature of this.map.querySourceFeatures(source, { sourceLayer })) {
      if (feature.id === undefined || feature.id === null) continue
      const unitId = String(feature.id)
      if (seen.has(unitId)) continue
      seen.add(unitId)
      this.map.setFeatureState(
        { id: feature.id, source, sourceLayer },
        { district: this.assignment[unitId] ?? 0 },
      )
    }
  }

  private syncEdges() {
    const edges = this.manifest.tiles.reference?.liveDistrictEdges
    if (!edges || !this.map.getSource(edgeSource)) return
    const seen = new Set<string>()
    for (const feature of this.map.querySourceFeatures(edgeSource, { sourceLayer: edges.sourceLayer })) {
      if (feature.id === undefined || feature.id === null || seen.has(String(feature.id))) continue
      seen.add(String(feature.id))
      const a = this.assignment[String(feature.properties?.u0 ?? "")] ?? 0
      const b = this.assignment[String(feature.properties?.u1 ?? "")] ?? 0
      this.map.setFeatureState(
        { id: feature.id, source: edgeSource, sourceLayer: edges.sourceLayer },
        { show: a !== b && (a > 0 || b > 0) },
      )
    }
  }
}

function installProtocol() {
  if (protocolInstalled) return
  const protocol = new Protocol()
  maplibregl.addProtocol("pmtiles", protocol.tile)
  protocolInstalled = true
}

function unitPaint(districts: number): FillLayerSpecification["paint"] {
  return {
    "fill-antialias": false,
    "fill-color": districtExpression(districts),
    "fill-opacity": ["case", [">", ["coalesce", ["feature-state", "district"], 0], 0], 0.82, 0.48],
  }
}

function districtExpression(districts: number): ExpressionSpecification {
  const expression: unknown[] = ["match", ["coalesce", ["feature-state", "district"], 0]]
  for (let district = 1; district <= districts; district += 1) {
    expression.push(district, districtColor(district))
  }
  expression.push("#d0cbc2")
  return expression as ExpressionSpecification
}

const palette = [
  "#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#9333ea", "#0891b2", "#ea580c", "#4f46e5",
  "#be123c", "#0f5f66", "#7c2d12", "#64748b", "#db2777", "#0284c7", "#65a30d", "#d97706",
  "#7c3aed", "#0d9488", "#f43f5e", "#0369a1", "#4d7c0f", "#b45309", "#6d28d9", "#0f766e",
  "#c026d3", "#059669", "#e11d48", "#1d4ed8", "#15803d", "#a16207", "#6b21a8", "#0e7490",
  "#be185d", "#047857", "#b91c1c", "#1e40af", "#166534", "#854d0e", "#581c87", "#155e75",
  "#9d174d", "#065f46", "#991b1b", "#312e81", "#365314", "#713f12", "#701a75", "#164e63",
]

function districtColor(district: number) {
  return palette[district - 1] ?? `hsl(${Math.round((district * 137.508) % 360)} 64% 46%)`
}

function paddedBounds([west, south, east, north]: [number, number, number, number]) {
  const longitude = Math.max((east - west) * 0.5, 2)
  const latitude = Math.max((north - south) * 0.5, 2)
  return [
    [Math.max(-180, west - longitude), Math.max(-90, south - latitude)],
    [Math.min(180, east + longitude), Math.min(90, north + latitude)],
  ] as [[number, number], [number, number]]
}
