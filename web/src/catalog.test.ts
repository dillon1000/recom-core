/**
 * Locks public viewer state/resolution mapping and share-URL parsing to the
 * dataset slugs served by the live beta Worker.
 */
import { describe, expect, it } from "vitest"

import { datasetSlug, resolutionFromQuery, states } from "./catalog"

describe("viewer dataset catalog", () => {
  it("maps precinct mode to each state's precinct sibling", () => {
    expect(states).toHaveLength(50)
    expect(datasetSlug("ri", "block-group")).toBe("ri")
    expect(datasetSlug("ri", "precinct")).toBe("ri-precincts")
    expect(datasetSlug("de-cd119", "precinct")).toBe("de-cd119-precincts")
  })

  it("defaults unsupported setup modes to block groups", () => {
    expect(resolutionFromQuery("precinct")).toBe("precinct")
    expect(resolutionFromQuery("block")).toBe("block-group")
  })
})
