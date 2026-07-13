/**
 * Lists the 50 congressional state choices and maps geography modes to the
 * public beta's block-group and precinct dataset siblings. District counts and
 * bounds remain manifest-owned so published data can change independently.
 */
import type { StateEntry, ViewerResolution } from "./types"

export const states: readonly StateEntry[] = [
  ["al", "AL", "Alabama"], ["ak", "AK", "Alaska"], ["az", "AZ", "Arizona"],
  ["ar", "AR", "Arkansas"], ["ca", "CA", "California"], ["co", "CO", "Colorado"],
  ["ct", "CT", "Connecticut"], ["de-cd119", "DE", "Delaware"],
  ["fl-cd119", "FL", "Florida"], ["ga", "GA", "Georgia"], ["hi", "HI", "Hawaii"],
  ["id", "ID", "Idaho"], ["il", "IL", "Illinois"], ["in", "IN", "Indiana"],
  ["ia", "IA", "Iowa"], ["ks", "KS", "Kansas"], ["ky", "KY", "Kentucky"],
  ["la", "LA", "Louisiana"], ["me", "ME", "Maine"], ["md", "MD", "Maryland"],
  ["ma", "MA", "Massachusetts"], ["mi", "MI", "Michigan"],
  ["mn", "MN", "Minnesota"], ["ms", "MS", "Mississippi"],
  ["mo", "MO", "Missouri"], ["mt", "MT", "Montana"], ["ne", "NE", "Nebraska"],
  ["nv", "NV", "Nevada"], ["nh", "NH", "New Hampshire"],
  ["nj", "NJ", "New Jersey"], ["nm", "NM", "New Mexico"], ["ny", "NY", "New York"],
  ["nc", "NC", "North Carolina"], ["nd", "ND", "North Dakota"], ["oh", "OH", "Ohio"],
  ["ok", "OK", "Oklahoma"], ["or", "OR", "Oregon"], ["pa", "PA", "Pennsylvania"],
  ["ri", "RI", "Rhode Island"], ["sc", "SC", "South Carolina"],
  ["sd", "SD", "South Dakota"], ["tn", "TN", "Tennessee"], ["tx", "TX", "Texas"],
  ["ut-cd119", "UT", "Utah"], ["vt", "VT", "Vermont"], ["va", "VA", "Virginia"],
  ["wa", "WA", "Washington"], ["wv", "WV", "West Virginia"],
  ["wi", "WI", "Wisconsin"], ["wy", "WY", "Wyoming"],
].map(([slug, postal, name]) => ({ slug, postal, name }))

export const stateBySlug = new Map(states.map((state) => [state.slug, state]))

export const viewerResolutions = ["block-group", "precinct"] as const satisfies readonly ViewerResolution[]

export function datasetSlug(stateSlug: string, resolution: ViewerResolution) {
  return resolution === "precinct" ? `${stateSlug}-precincts` : stateSlug
}

export function resolutionFromQuery(value: string | null): ViewerResolution {
  return value === "precinct" ? "precinct" : "block-group"
}

export function resolutionLabel(resolution: ViewerResolution) {
  return resolution === "precinct" ? "2024 precincts" : "Census block groups"
}
