/** Verifies the versioned, direction-aware Resigned2 browser bridge contract. */
import { describe, expect, it } from "vitest"

import {
  datasetSelection,
  handoffMessage,
  isHandoffMessage,
  parseLaunchContextMessage,
  resigned2HandoffURL,
} from "./handoff"

const token = "11111111-2222-4333-8444-555555555555"

describe("Resigned2 handoff", () => {
  it("validates a launch context and keeps direction in the envelope", () => {
    const message = handoffMessage("resigned2-to-recom", "context", token, {
      context: {
        assignment: { one: 1, two: 2 },
        datasetSlug: "tx-precincts",
        districtCount: 38,
        unitCount: 2,
      },
    })
    expect(parseLaunchContextMessage(message, token)).toMatchObject({
      datasetSlug: "tx-precincts",
      assignment: { one: 1, two: 2 },
    })
    expect(isHandoffMessage(message, "recom-to-resigned2", "context", token)).toBe(false)
  })

  it("maps dataset siblings to the viewer controls", () => {
    expect(datasetSelection("tx")).toEqual({ resolution: "block-group", stateSlug: "tx" })
    expect(datasetSelection("tx-precincts")).toEqual({ resolution: "precinct", stateSlug: "tx" })
    expect(() => datasetSelection("not-a-state")).toThrow("unavailable")
  })

  it("builds the path-mounted Resigned2 receiver URL", () => {
    expect(resigned2HandoffURL(token)).toBe(
      `https://dillonr.ing/redistricting/v1/handoff/recom?token=${token}`,
    )
  })
})
