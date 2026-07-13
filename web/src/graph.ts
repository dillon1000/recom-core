/**
 * Converts published adjacency into the dense CSR arrays consumed by WASM.
 * Inputs are immutable unit records, adjacency, and a published assignment;
 * outputs include deterministic virtual links for islands and disconnected
 * reference-district pieces so every starting district is contiguous.
 */
import type {
  AssignmentMap,
  GraphInput,
  Unit,
  UnitAdjacency,
  UnitAdjacencyWeights,
} from "./types"

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

export function assignmentWithinTolerance(
  units: Unit[],
  assignment: Uint16Array,
  districtCount: number,
  tolerance: number,
) {
  if (assignment.length !== units.length || districtCount < 1 || tolerance < 0) return false
  const populations = Array.from({ length: districtCount }, () => 0)
  let totalPopulation = 0
  for (let index = 0; index < units.length; index += 1) {
    const district = assignment[index]
    const unit = units[index]
    if (!unit || district === undefined || district < 1 || district > districtCount) return false
    populations[district - 1] = (populations[district - 1] ?? 0) + unit.popTotal
    totalPopulation += unit.popTotal
  }
  const idealPopulation = totalPopulation / districtCount
  return idealPopulation > 0 && populations.every(
    (population) => Math.abs(population - idealPopulation) <= idealPopulation * tolerance,
  )
}

export function buildGraph(
  adjacency: UnitAdjacency,
  units: Unit[],
  adjacencyWeights?: UnitAdjacencyWeights,
): GraphInput {
  const unitIds = units.map((unit) => unit.unitId)
  const indexById = new Map(unitIds.map((unitId, index) => [unitId, index]))
  if (indexById.size !== units.length) throw new Error("Unit IDs must be unique.")
  if (adjacencyWeights) validateAdjacencyWeights(adjacency, unitIds, adjacencyWeights)

  const neighborRows = unitIds.map((unitId) =>
    (adjacency[unitId] ?? [])
      .map((neighbor, position) => {
        const index = indexById.get(neighbor)
        if (index === undefined) return undefined
        return { index, weight: adjacencyWeights?.[unitId]?.[position] ?? 1 }
      })
      .filter((entry): entry is { index: number; weight: number } => entry !== undefined),
  )
  const offsets = new Uint32Array(unitIds.length + 1)
  const neighbors = new Uint32Array(neighborRows.reduce((sum, row) => sum + row.length, 0))
  const edgeCountyCross = new Uint8Array(neighbors.length)
  const edgeWeights = adjacencyWeights ? new Uint32Array(neighbors.length) : undefined
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
      neighbors[cursor] = neighbor.index
      edgeCountyCross[cursor] = Number(unit.countyFips !== units[neighbor.index]?.countyFips)
      if (edgeWeights) edgeWeights[cursor] = neighbor.weight
      cursor += 1
    }
  }
  offsets[unitIds.length] = cursor
  return {
    edgeCountyCross,
    ...(edgeWeights ? { edgeWeights } : {}),
    neighbors,
    offsets,
    populations,
    unitIds,
  }
}

export function connectComponents(
  adjacency: UnitAdjacency,
  unitIds: string[],
  assignment: Uint16Array,
  adjacencyWeights?: UnitAdjacencyWeights,
) {
  if (assignment.length !== unitIds.length) throw new Error("Starting assignment does not match units.")
  if (adjacencyWeights) validateAdjacencyWeights(adjacency, unitIds, adjacencyWeights)
  const unitIndex = new Map(unitIds.map((unitId, index) => [unitId, index]))
  const allUnits = new Set(unitIds)
  const graphComponents = components(adjacency, unitIds, allUnits)
  const next = cloneAdjacency(adjacency, unitIds)
  const weightMaps = adjacencyWeights
    ? new Map(unitIds.map((unitId) => [
        unitId,
        new Map((adjacency[unitId] ?? []).map((neighbor, index) => [
          neighbor,
          adjacencyWeights[unitId]?.[index] ?? 1,
        ])),
      ]))
    : undefined
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
      addEdge(next, from, to, weightMaps)
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
      addEdge(next, from, to, weightMaps)
      virtualEdges += 1
      for (const unitId of component) connected.add(unitId)
    }
  }

  const edgeWeights = weightMaps
    ? Object.fromEntries(unitIds.map((unitId) => [
        unitId,
        (next[unitId] ?? []).map((neighbor) => weightMaps.get(unitId)?.get(neighbor) ?? 1),
      ]))
    : undefined
  return { adjacency: next, ...(edgeWeights ? { edgeWeights } : {}), virtualEdges }
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

function addEdge(
  adjacency: UnitAdjacency,
  from: string,
  to: string,
  weightMaps?: Map<string, Map<string, number>>,
) {
  adjacency[from] = sortedUnique([...(adjacency[from] ?? []), to])
  adjacency[to] = sortedUnique([...(adjacency[to] ?? []), from])
  weightMaps?.get(from)?.set(to, weightMaps.get(from)?.get(to) ?? 1)
  weightMaps?.get(to)?.set(from, weightMaps.get(to)?.get(from) ?? 1)
}

function validateAdjacencyWeights(
  adjacency: UnitAdjacency,
  unitIds: string[],
  weights: UnitAdjacencyWeights,
) {
  const unitSet = new Set(unitIds)
  for (const unitId of unitIds) {
    const neighbors = adjacency[unitId] ?? []
    const row = weights[unitId]
    if (!row || row.length !== neighbors.length) {
      throw new Error(`Adjacency weights for ${unitId} must align with its neighbor row.`)
    }
    const uniqueNeighbors = new Set(neighbors)
    if (uniqueNeighbors.size !== neighbors.length) {
      throw new Error(`Adjacency for ${unitId} contains duplicate neighbors.`)
    }
    for (let index = 0; index < neighbors.length; index += 1) {
      const neighbor = neighbors[index]
      const weight = row[index]
      if (!Number.isSafeInteger(weight) || weight === undefined || weight < 1 || weight > 0xffff_ffff) {
        throw new Error(`Adjacency weight for ${unitId} → ${neighbor ?? "unknown"} must fit a positive u32.`)
      }
      if (!neighbor || !unitSet.has(neighbor)) continue
      const reverseIndex = (adjacency[neighbor] ?? []).indexOf(unitId)
      if (reverseIndex < 0 || weights[neighbor]?.[reverseIndex] !== weight) {
        throw new Error(`Adjacency weights for ${unitId} and ${neighbor} must be symmetric.`)
      }
    }
  }
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
