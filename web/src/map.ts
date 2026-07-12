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
const planetSource = "planet"
const planetArchive = "https://tiles.totallynotacdn.com/map/planet-2026-05-21.pmtiles"
const planetGlyphs = "https://tiles.totallynotacdn.com/map/glyphs/{fontstack}/{range}.pbf"
let protocolInstalled = false

export class ViewerMap {
  private assignment: AssignmentMap = {}
  private readonly map: maplibregl.Map
  private animationFrame: number | null = null
  private hoveredFeature: { id: string | number; source: string; sourceLayer: string } | null = null
  private hoveredUnitId: string | null = null

  constructor(
    container: HTMLElement,
    private readonly manifest: Manifest,
    private readonly onHover: (unitId: string | null) => void,
  ) {
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
        glyphs: planetGlyphs,
        sources: {},
        layers: [{ id: "background", type: "background", paint: { "background-color": "#eeeae3" } }],
      },
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "imperial" }), "bottom-right")
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right")
    this.map.on("load", () => {
      installPlanetBase(this.map)
      this.installUnitLayers()
      this.installEdgeLayer()
      installPlanetLabels(this.map)
      this.scheduleSync()
    })
    this.map.on("sourcedata", () => this.scheduleSync())
    this.map.on("moveend", () => this.scheduleSync())
    this.map.on("mousemove", (event) => this.handleHover(event))
    this.map.on("mouseout", () => this.clearHover())
  }

  setAssignment(assignment: AssignmentMap) {
    this.assignment = assignment
    if (this.map.isStyleLoaded()) this.scheduleSync()
  }

  destroy() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.clearHover()
    this.map.remove()
  }

  private handleHover(event: maplibregl.MapMouseEvent) {
    const layers = ["units-fill", "units-coarse-fill"].filter((layer) => this.map.getLayer(layer))
    const feature = layers.length
      ? this.map.queryRenderedFeatures(event.point, { layers })[0]
      : undefined
    if (!feature || feature.id === undefined || feature.id === null || !feature.sourceLayer) {
      this.clearHover()
      return
    }
    const next = { id: feature.id, source: feature.source, sourceLayer: feature.sourceLayer }
    if (
      !this.hoveredFeature
      || this.hoveredFeature.id !== next.id
      || this.hoveredFeature.source !== next.source
    ) {
      this.clearHover()
      this.hoveredFeature = next
      this.map.setFeatureState(next, { hover: true })
    }
    this.map.getCanvas().style.cursor = "crosshair"
    const unitId = String(feature.id)
    if (unitId !== this.hoveredUnitId) {
      this.hoveredUnitId = unitId
      this.onHover(unitId)
    }
  }

  private clearHover() {
    if (this.hoveredFeature) this.map.setFeatureState(this.hoveredFeature, { hover: false })
    this.hoveredFeature = null
    this.map.getCanvas().style.cursor = ""
    if (this.hoveredUnitId !== null) {
      this.hoveredUnitId = null
      this.onHover(null)
    }
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

function installPlanetBase(map: maplibregl.Map) {
  map.addSource(planetSource, {
    type: "vector",
    url: `pmtiles://${planetArchive}`,
    minzoom: 0,
    maxzoom: 15,
    attribution: "© OpenMapTiles © OpenStreetMap contributors",
  })
  map.addLayer({
    id: "planet-landcover", type: "fill", source: planetSource, "source-layer": "landcover",
    paint: {
      "fill-color": [
        "match", ["get", "class"],
        ["wood", "forest"], "#d7e7d2",
        ["grass", "scrub", "farmland", "meadow"], "#e3ead7",
        ["ice", "snow"], "#eff6ff", "#eeeae3",
      ],
      "fill-opacity": 0.7,
    },
  })
  map.addLayer({
    id: "planet-landuse", type: "fill", source: planetSource, "source-layer": "landuse", minzoom: 6,
    paint: {
      "fill-color": [
        "match", ["get", "class"],
        ["residential", "suburb"], "#ece7de",
        ["industrial", "commercial"], "#e5e7eb",
        ["cemetery", "park", "pitch"], "#dcebd6", "#edf2ef",
      ],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.18, 12, 0.52],
    },
  })
  map.addLayer({
    id: "planet-park", type: "fill", source: planetSource, "source-layer": "park", minzoom: 6,
    paint: { "fill-color": "#d7ead4", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.24, 12, 0.64] },
  })
  map.addLayer({
    id: "planet-water", type: "fill", source: planetSource, "source-layer": "water",
    paint: { "fill-color": "#c7ddeb", "fill-opacity": 0.92 },
  })
  map.addLayer({
    id: "planet-waterway", type: "line", source: planetSource, "source-layer": "waterway", minzoom: 8,
    paint: { "line-color": "#a9cfe4", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 13, 1.5] },
  })
  map.addLayer({
    id: "planet-boundary", type: "line", source: planetSource, "source-layer": "boundary", minzoom: 3,
    filter: ["all", ["!=", ["get", "maritime"], 1], ["match", ["to-number", ["get", "admin_level"]], [4, 6], true, false]],
    paint: { "line-color": "#64748b", "line-dasharray": [2, 2], "line-opacity": 0.5, "line-width": 0.8 },
  })
  map.addLayer({
    id: "planet-road-casing", type: "line", source: planetSource, "source-layer": "transportation", minzoom: 5,
    filter: roadClassFilter(),
    paint: { "line-color": "#ffffff", "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.28, 11, 0.78], "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 9, 2.5, 14, 7] },
  })
  map.addLayer({
    id: "planet-roads", type: "line", source: planetSource, "source-layer": "transportation", minzoom: 5,
    filter: roadClassFilter(),
    paint: {
      "line-color": ["match", ["get", "class"], ["motorway", "trunk"], "#d97706", ["primary", "secondary"], "#94a3b8", "#cbd5e1"],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 11, 0.74],
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.35, 9, 1.2, 14, 4.2],
    },
  })
  map.addLayer({
    id: "planet-buildings", type: "fill", source: planetSource, "source-layer": "building", minzoom: 14,
    paint: { "fill-color": "#94a3b8", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.12, 17, 0.34] },
  })
}

function installPlanetLabels(map: maplibregl.Map) {
  map.addLayer({
    id: "planet-road-labels", type: "symbol", source: planetSource, "source-layer": "transportation_name", minzoom: 10,
    filter: roadClassFilter(),
    layout: { "symbol-placement": "line", "text-field": nameExpression(), "text-font": ["Geist Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 13] },
    paint: { "text-color": "#475569", "text-halo-color": "#fffdf8", "text-halo-width": 1 },
  })
  map.addLayer({
    id: "planet-place-labels", type: "symbol", source: planetSource, "source-layer": "place", minzoom: 4,
    filter: ["match", ["get", "class"], ["city", "town", "village", "suburb"], true, false],
    layout: { "text-field": nameExpression(), "text-font": ["Geist Medium"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 9, 16], "text-allow-overlap": false },
    paint: { "text-color": "#171717", "text-halo-color": "#fffdf8", "text-halo-width": 1.2 },
  })
  map.addLayer({
    id: "planet-poi-labels", type: "symbol", source: planetSource, "source-layer": "poi", minzoom: 12,
    layout: { "text-field": nameExpression(), "text-font": ["Geist Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 12], "text-allow-overlap": false },
    paint: { "text-color": "#475569", "text-halo-color": "#fffdf8", "text-halo-width": 1 },
  })
}

function nameExpression(): ExpressionSpecification {
  return ["coalesce", ["get", "name_en"], ["get", "name"], ["get", "NAME"], ["get", "label"]] as ExpressionSpecification
}

function roadClassFilter() {
  return [
    "match", ["get", "class"],
    ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "street"],
    true, false,
  ] as unknown as maplibregl.FilterSpecification
}

function unitPaint(districts: number): FillLayerSpecification["paint"] {
  return {
    "fill-antialias": false,
    "fill-color": districtExpression(districts),
    "fill-opacity": [
      "case",
      ["boolean", ["feature-state", "hover"], false], 0.94,
      [">", ["coalesce", ["feature-state", "district"], 0], 0], 0.68,
      0.3,
    ],
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
