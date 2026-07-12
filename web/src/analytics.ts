/**
 * Derives all public observatory measures from one generated assignment. Inputs
 * are compact Census/election unit rows and ReCom status; outputs cover balance,
 * county fragmentation, demographics, electoral representation, and per-
 * district diagnostics without requiring geometry or another network request.
 */
import type { AssignmentMap, ChainStatus, Unit } from "./types"

export const demographicKeys = ["white", "black", "hispanic", "asian", "native"] as const
export type DemographicKey = (typeof demographicKeys)[number]
export type Demographics = Record<DemographicKey, number> & { other: number }

export type DistrictAnalytics = {
  district: number
  population: number
  units: number
  counties: number
  deviationPercent: number
  demographics: Demographics
  demographicShares: Demographics
  election: {
    demVotes: number
    repVotes: number
    otherVotes: number
    twoPartyVotes: number
    demShare: number | null
    repShare: number | null
  }
}

export type PlanAnalytics = {
  districts: DistrictAnalytics[]
  totalPopulation: number
  totalUnits: number
  idealPopulation: number
  maxDeviationPercent: number
  meanAbsoluteDeviationPercent: number
  medianAbsoluteDeviationPercent: number
  populationRange: number
  acceptanceRate: number
  cutEdges: number
  cutEdgesPerDistrict: number
  counties: { total: number; splitCount: number; districtPairs: number }
  demographics: {
    totals: Demographics
    shares: Demographics
    majorityNonWhiteDistricts: number
    black40: number
    hispanic40: number
    asian30: number
  }
  election: {
    demVotes: number
    repVotes: number
    twoPartyVotes: number
    demShare: number | null
    repShare: number | null
    demSeats: number
    repSeats: number
    competitiveDistricts: number
    medianDistrictDemShare: number | null
    meanMedianGap: number | null
    seatVoteGap: number | null
    efficiencyGap: number | null
  }
}

export function computeAnalytics(
  units: Unit[],
  assignment: AssignmentMap,
  districtCount: number,
  status: ChainStatus,
): PlanAnalytics {
  const rows = Array.from({ length: districtCount }, (_, index) => ({
    district: index + 1,
    population: 0,
    units: 0,
    counties: new Set<string>(),
    demographics: emptyDemographics(),
    demVotes: 0,
    repVotes: 0,
    otherVotes: 0,
  }))
  const districtsByCounty = new Map<string, Set<number>>()
  let totalPopulation = 0

  for (const unit of units) {
    const district = assignment[unit.unitId]
    if (!Number.isInteger(district) || district === undefined || district < 1 || district > districtCount) {
      throw new Error(`Generated assignment is missing a valid district for ${unit.unitId}.`)
    }
    const row = rows[district - 1]
    if (!row) throw new Error(`District ${district} is unavailable.`)
    row.population += unit.popTotal
    row.units += 1
    row.counties.add(unit.countyFips)
    row.demographics.white += unit.popWhite
    row.demographics.black += unit.popBlack
    row.demographics.hispanic += unit.popHispanic
    row.demographics.asian += unit.popAsian
    row.demographics.native += unit.popNative + unit.popPacific
    row.demographics.other += unit.popOther
    row.demVotes += unit.president2024.dem
    row.repVotes += unit.president2024.rep
    row.otherVotes += unit.president2024.other
    totalPopulation += unit.popTotal
    const countyDistricts = districtsByCounty.get(unit.countyFips) ?? new Set<number>()
    countyDistricts.add(district)
    districtsByCounty.set(unit.countyFips, countyDistricts)
  }

  const idealPopulation = totalPopulation / districtCount
  const districts: DistrictAnalytics[] = rows.map((row) => {
    const twoPartyVotes = row.demVotes + row.repVotes
    const demShare = twoPartyVotes ? row.demVotes / twoPartyVotes : null
    return {
      district: row.district,
      population: row.population,
      units: row.units,
      counties: row.counties.size,
      deviationPercent: idealPopulation ? ((row.population - idealPopulation) / idealPopulation) * 100 : 0,
      demographics: row.demographics,
      demographicShares: shares(row.demographics, row.population),
      election: {
        demVotes: row.demVotes,
        repVotes: row.repVotes,
        otherVotes: row.otherVotes,
        twoPartyVotes,
        demShare,
        repShare: demShare === null ? null : 1 - demShare,
      },
    }
  })
  const absoluteDeviations = districts.map((district) => Math.abs(district.deviationPercent))
  const populations = districts.map((district) => district.population)
  const statewideDemographics = districts.reduce(
    (total, district) => addDemographics(total, district.demographics),
    emptyDemographics(),
  )
  const election = electionAnalytics(districts)
  const totalSteps = status.stepsAccepted + status.stepsRejected

  return {
    districts,
    totalPopulation,
    totalUnits: units.length,
    idealPopulation,
    maxDeviationPercent: Math.max(0, ...absoluteDeviations),
    meanAbsoluteDeviationPercent: average(absoluteDeviations),
    medianAbsoluteDeviationPercent: median(absoluteDeviations),
    populationRange: Math.max(0, ...populations) - Math.min(...populations),
    acceptanceRate: totalSteps ? status.stepsAccepted / totalSteps : 0,
    cutEdges: status.bestScore.cutEdges,
    cutEdgesPerDistrict: status.bestScore.cutEdges / districtCount,
    counties: {
      total: districtsByCounty.size,
      splitCount: [...districtsByCounty.values()].filter((districtSet) => districtSet.size > 1).length,
      districtPairs: [...districtsByCounty.values()].reduce(
        (total, districtSet) => total + Math.max(0, districtSet.size - 1),
        0,
      ),
    },
    demographics: {
      totals: statewideDemographics,
      shares: shares(statewideDemographics, totalPopulation),
      majorityNonWhiteDistricts: districts.filter((district) => district.demographicShares.white < 0.5).length,
      black40: districts.filter((district) => district.demographicShares.black >= 0.4).length,
      hispanic40: districts.filter((district) => district.demographicShares.hispanic >= 0.4).length,
      asian30: districts.filter((district) => district.demographicShares.asian >= 0.3).length,
    },
    election,
  }
}

function electionAnalytics(districts: DistrictAnalytics[]): PlanAnalytics["election"] {
  const reporting = districts.filter((district) => district.election.demShare !== null)
  const demVotes = reporting.reduce((sum, district) => sum + district.election.demVotes, 0)
  const repVotes = reporting.reduce((sum, district) => sum + district.election.repVotes, 0)
  const twoPartyVotes = demVotes + repVotes
  const demShare = twoPartyVotes ? demVotes / twoPartyVotes : null
  const districtShares = reporting
    .map((district) => district.election.demShare)
    .filter((share): share is number => share !== null)
  const demSeats = districtShares.filter((share) => share > 0.5).length
  const repSeats = districtShares.filter((share) => share < 0.5).length
  const medianDistrictDemShare = districtShares.length ? median(districtShares) : null
  let wastedDem = 0
  let wastedRep = 0
  for (const district of reporting) {
    const threshold = Math.floor(district.election.twoPartyVotes / 2) + 1
    wastedDem += district.election.demVotes >= threshold
      ? district.election.demVotes - threshold
      : district.election.demVotes
    wastedRep += district.election.repVotes >= threshold
      ? district.election.repVotes - threshold
      : district.election.repVotes
  }
  const demSeatShare = reporting.length ? demSeats / reporting.length : 0
  return {
    demVotes,
    repVotes,
    twoPartyVotes,
    demShare,
    repShare: demShare === null ? null : 1 - demShare,
    demSeats,
    repSeats,
    competitiveDistricts: districtShares.filter((share) => Math.abs(share - 0.5) < 0.05).length,
    medianDistrictDemShare,
    meanMedianGap: medianDistrictDemShare === null ? null : average(districtShares) - medianDistrictDemShare,
    seatVoteGap: demShare === null ? null : demSeatShare - demShare,
    efficiencyGap: twoPartyVotes ? (wastedRep - wastedDem) / twoPartyVotes : null,
  }
}

function emptyDemographics(): Demographics {
  return { white: 0, black: 0, hispanic: 0, asian: 0, native: 0, other: 0 }
}

function addDemographics(target: Demographics, source: Demographics) {
  for (const key of [...demographicKeys, "other"] as const) target[key] += source[key]
  return target
}

function shares(totals: Demographics, population: number) {
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, population ? value / population : 0]),
  ) as Demographics
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
