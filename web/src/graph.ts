/**
 * Converts published adjacency into the dense CSR arrays consumed by WASM.
 * Inputs are immutable unit records, adjacency, and a published assignment;
 * outputs include deterministic virtual links for islands and disconnected
 * reference-district pieces so every starting district is contiguous.
 */
import type { AssignmentMap, GraphInput, Unit, UnitAdjacency } from "./types"

export function assignmentToDense(unitIds: string[], assignment: AssignmentMap) {
  return Uint16Array.from(unitIds, (unitId) => {
    const district = assignment[unitId]
    if (!Number.isInteger(district) || district === undefined || district < 1 || district > 0xffff) {
      throw new Error(`Assignment for ${unitId} is not a positive 16-bit district label.`)
    }
    return district
  })
}

export function denseToAssignment(unitIds: string[], assignment: Uint16Array) {
  if (unitIds.length !== assignment.length) throw new Error("Assignment length does not match units.")
  return Object.fromEntries(unitIds.map((unitId, index) => [unitId, assignment[index] ?? 0]))
}

export function buildGraph(adjacency: UnitAdjacency, units: Unit[]): GraphInput {
  const unitIds = units.map((unit) => unit.unitId)
  const indexById = new Map(unitIds.map((unitId, index) => [unitId, index]))
  if (indexById.size !== units.length) throw new Error("Unit IDs must be unique.")

  const neighborRows = unitIds.map((unitId) =>
    (adjacency[unitId] ?? [])
      .map((neighbor) => indexById.get(neighbor))
      .filter((index): index is number => index !== undefined),
  )
  const offsets = new Uint32Array(unitIds.length + 1)
  const neighbors = new Uint32Array(neighborRows.reduce((sum, row) => sum + row.length, 0))
  const edgeCountyCross = new Uint8Array(neighbors.length)
  const populations = new Uint32Array(unitIds.length)
  let cursor = 0

  for (let node = 0; node < units.length; node += 1) {
    const unit = units[node]
    if (!unit || !Number.isSafeInteger(unit.popTotal) || unit.popTotal < 0 || unit.popTotal > 0xffff_ffff) {
      throw new Error(`Population for ${unit?.unitId ?? node} must fit an unsigned 32-bit integer.`)
    }
    populations[node] = unit.popTotal
    offsets[node] = cursor
    for (const neighbor of neighborRows[node] ?? []) {
      neighbors[cursor] = neighbor
      edgeCountyCross[cursor] = Number(unit.countyFips !== units[neighbor]?.countyFips)
      cursor += 1
    }
  }
  offsets[unitIds.length] = cursor
  return { edgeCountyCross, neighbors, offsets, populations, unitIds }
}

export function connectComponents(
  adjacency: UnitAdjacency,
  unitIds: string[],
  assignment: Uint16Array,
) {
  if (assignment.length !== unitIds.length) throw new Error("Starting assignment does not match units.")
  const unitIndex = new Map(unitIds.map((unitId, index) => [unitId, index]))
  const allUnits = new Set(unitIds)
  const graphComponents = components(adjacency, unitIds, allUnits)
  let next = cloneAdjacency(adjacency, unitIds)
  let virtualEdges = 0

  if (graphComponents.length > 1) {
    graphComponents.sort(largestFirst)
    const connected = new Set(graphComponents[0])
    const anchors = districtAnchors(connected, assignment, unitIndex)
    for (const component of graphComponents.slice(1).sort(byMinimumUnit)) {
      const sorted = [...component].sort(compareUnitIds)
      let from = sorted[0]
      let to = minimumUnit(connected)
      for (const unitId of sorted) {
        const district = districtFor(unitId, assignment, unitIndex)
        const anchor = anchors.get(district)
        if (anchor) {
          from = unitId
          to = anchor
          break
        }
      }
      if (!from || !to) throw new Error("Cannot link an empty adjacency component.")
      addEdge(next, from, to)
      virtualEdges += 1
      for (const unitId of component) connected.add(unitId)
      updateAnchors(anchors, component, assignment, unitIndex)
    }
  }

  const unitsByDistrict = new Map<number, string[]>()
  for (const unitId of unitIds) {
    const district = districtFor(unitId, assignment, unitIndex)
    const districtUnits = unitsByDistrict.get(district) ?? []
    districtUnits.push(unitId)
    unitsByDistrict.set(district, districtUnits)
  }

  for (const [, districtUnits] of [...unitsByDistrict].sort((a, b) => a[0] - b[0])) {
    const districtComponents = components(next, districtUnits, new Set(districtUnits))
    if (districtComponents.length <= 1) continue
    districtComponents.sort(largestFirst)
    const connected = new Set(districtComponents[0])
    for (const component of districtComponents.slice(1).sort(byMinimumUnit)) {
      const from = minimumUnit(component)
      const to = minimumUnit(connected)
      if (!from || !to) throw new Error("Cannot link an empty district component.")
      addEdge(next, from, to)
      virtualEdges += 1
      for (const unitId of component) connected.add(unitId)
    }
  }

  return { adjacency: next, virtualEdges }
}

function components(adjacency: UnitAdjacency, unitIds: string[], allowed: Set<string>) {
  const seen = new Set<string>()
  const result: string[][] = []
  for (const unitId of unitIds) {
    if (seen.has(unitId)) continue
    const component: string[] = []
    const stack = [unitId]
    seen.add(unitId)
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      component.push(current)
      for (const neighbor of adjacency[current] ?? []) {
        if (!allowed.has(neighbor) || seen.has(neighbor)) continue
        seen.add(neighbor)
        stack.push(neighbor)
      }
    }
    component.sort(compareUnitIds)
    result.push(component)
  }
  return result
}

function cloneAdjacency(adjacency: UnitAdjacency, unitIds: string[]) {
  return Object.fromEntries(unitIds.map((unitId) => [unitId, [...(adjacency[unitId] ?? [])]]))
}

function addEdge(adjacency: UnitAdjacency, from: string, to: string) {
  adjacency[from] = sortedUnique([...(adjacency[from] ?? []), to])
  adjacency[to] = sortedUnique([...(adjacency[to] ?? []), from])
}

function districtAnchors(
  units: Iterable<string>,
  assignment: Uint16Array,
  unitIndex: Map<string, number>,
) {
  const anchors = new Map<number, string>()
  updateAnchors(anchors, units, assignment, unitIndex)
  return anchors
}

function updateAnchors(
  anchors: Map<number, string>,
  units: Iterable<string>,
  assignment: Uint16Array,
  unitIndex: Map<string, number>,
) {
  for (const unitId of units) {
    const district = districtFor(unitId, assignment, unitIndex)
    const current = anchors.get(district)
    if (!current || compareUnitIds(unitId, current) < 0) anchors.set(district, unitId)
  }
}

function districtFor(unitId: string, assignment: Uint16Array, unitIndex: Map<string, number>) {
  const index = unitIndex.get(unitId)
  const district = index === undefined ? undefined : assignment[index]
  if (!district) throw new Error(`Starting assignment is missing unit ${unitId}.`)
  return district
}

function largestFirst(a: string[], b: string[]) {
  return b.length - a.length || compareUnitIds(a[0] ?? "", b[0] ?? "")
}

function byMinimumUnit(a: string[], b: string[]) {
  return compareUnitIds(minimumUnit(a), minimumUnit(b))
}

function minimumUnit(units: Iterable<string>) {
  let minimum = ""
  for (const unitId of units) {
    if (!minimum || compareUnitIds(unitId, minimum) < 0) minimum = unitId
  }
  return minimum
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort(compareUnitIds)
}

function compareUnitIds(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true })
}
