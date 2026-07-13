/**
 * Normalizes published unit statistics into the compact public-viewer shape.
 * Inputs are Arrow IPC for block groups or JSON arrays for precincts; outputs
 * preserve population, demographic, county, label, and presidential fields.
 */
import { tableFromIPC } from "apache-arrow"

import type { Unit } from "./types"

type UnitRecord = Record<string, unknown>

export async function parseUnits(buffer: ArrayBuffer, sourceUrl: string) {
  if (/\.json(?:$|[?#])/i.test(sourceUrl)) {
    const parsed = JSON.parse(new TextDecoder().decode(buffer)) as unknown
    if (!Array.isArray(parsed)) throw new Error("Unit statistics JSON must contain an array.")
    return parsed.map((row, index) => normalizeUnit(row, index))
  }

  const table = await tableFromIPC(new Uint8Array(buffer))
  const units: Unit[] = []
  for (const batch of table.batches) {
    for (let index = 0; index < batch.numRows; index += 1) {
      const row = batch.get(index) as UnitRecord | null
      if (row) units.push(normalizeUnit(row, units.length))
    }
  }
  return units
}

function normalizeUnit(value: unknown, index: number): Unit {
  if (!value || typeof value !== "object") {
    throw new Error(`State statistics contain an invalid unit at row ${index}.`)
  }
  const row = value as UnitRecord
  const partisanship = objectValue(row.partisanship)
  const president = objectValue(partisanship?.president2024)
  const unit = {
    unitId: String(row.unitId ?? row.geoid ?? ""),
    countyFips: String(row.countyFips ?? ""),
    countyName: String(row.countyName ?? ""),
    label: String(row.label ?? ""),
    popTotal: Number(row.popTotal),
    popWhite: finite(row.popWhite),
    popBlack: finite(row.popBlack),
    popHispanic: finite(row.popHispanic),
    popAsian: finite(row.popAsian),
    popNative: finite(row.popNative),
    popPacific: finite(row.popPacific),
    popOther: finite(row.popOther),
    president2024: {
      dem: finite(president?.dem ?? row["partisanship.president2024.dem"]),
      rep: finite(president?.rep ?? row["partisanship.president2024.rep"]),
      other: finite(president?.other ?? row["partisanship.president2024.other"]),
    },
  }
  if (!unit.unitId || !Number.isSafeInteger(unit.popTotal) || unit.popTotal < 0) {
    throw new Error(`State statistics contain an invalid unit at row ${index}.`)
  }
  return unit
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? value as UnitRecord : undefined
}

function finite(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
