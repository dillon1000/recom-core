/**
 * Defines the public viewer's categorical and partisan map encodings. Inputs
 * are feature-state district/share values; outputs are MapLibre expressions
 * and stable red-neutral-blue gradient stops used by rendering and tests.
 */
import type { ExpressionSpecification } from "maplibre-gl"

export type MapColorMode = "district" | "partisanship"

export const partisanGradientStops = [
  { color: "#b91c1c", demShare: 0.35 },
  { color: "#dc766d", demShare: 0.425 },
  { color: "#e8e2d8", demShare: 0.5 },
  { color: "#7d9ad3", demShare: 0.575 },
  { color: "#1d4ed8", demShare: 0.65 },
] as const

export function districtDemocraticShare(
  districtDemShares: Array<number | null>,
  district: number,
) {
  return districtDemShares[district - 1] ?? 0.5
}

export function partisanFillExpression(): ExpressionSpecification {
  const share = ["coalesce", ["feature-state", "demShare"], 0.5] as ExpressionSpecification
  return [
    "case",
    ["<=", ["coalesce", ["feature-state", "district"], 0], 0],
    "#d0cbc2",
    [
      "interpolate",
      ["linear"],
      share,
      ...partisanGradientStops.flatMap((stop) => [stop.demShare, stop.color]),
    ],
  ] as unknown as ExpressionSpecification
}
