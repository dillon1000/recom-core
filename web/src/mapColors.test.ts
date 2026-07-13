/**
 * Locks the public map's district-level partisan gradient and share lookup.
 */
import { describe, expect, it } from "vitest"

import {
  districtDemocraticShare,
  partisanFillExpression,
  partisanGradientStops,
} from "./mapColors"

describe("partisan map colors", () => {
  it("runs from Republican red through even to Democratic blue", () => {
    expect(partisanGradientStops.map((stop) => stop.demShare)).toEqual([
      0.35, 0.425, 0.5, 0.575, 0.65,
    ])
    expect(partisanGradientStops[0]?.color).toBe("#b91c1c")
    expect(partisanGradientStops.at(-1)?.color).toBe("#1d4ed8")
    expect(partisanFillExpression()[0]).toBe("case")
  })

  it("preserves nearby aggregate district shares and uses a neutral fallback", () => {
    expect(districtDemocraticShare([0.6, 0.58, null], 1)).toBe(0.6)
    expect(districtDemocraticShare([0.6, 0.58, null], 2)).toBe(0.58)
    expect(districtDemocraticShare([0.6, 0.58, null], 3)).toBe(0.5)
  })
})
