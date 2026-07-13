/**
 * Covers the precinct JSON contract, including its nested presidential result,
 * so adding the geography mode cannot silently erase election analytics.
 */
import { describe, expect, it } from "vitest"

import { parseUnits } from "./unitParser"

describe("parseUnits", () => {
  it("normalizes precinct JSON statistics", async () => {
    const buffer = new TextEncoder().encode(JSON.stringify([{
      unitId: "44001-P1",
      countyFips: "001",
      countyName: "Bristol County",
      label: "Precinct 1",
      popTotal: 1200,
      popWhite: 900,
      popBlack: 80,
      popHispanic: 140,
      popAsian: 50,
      popNative: 10,
      popPacific: 0,
      popOther: 20,
      partisanship: { president2024: { dem: 600, rep: 400, other: 20 } },
    }])).buffer

    const units = await parseUnits(buffer, "/unit-stats.abc.json")
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      unitId: "44001-P1",
      popTotal: 1200,
      president2024: { dem: 600, rep: 400, other: 20 },
    })
  })
})
