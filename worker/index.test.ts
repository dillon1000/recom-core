/**
 * Protects the viewer Worker's public path and range contracts without binding
 * tests to a remote R2 bucket.
 */
import { describe, expect, it } from "vitest"

import worker, {
  parseByteRange,
  stateFileRequest,
  type WasmArBetaEnv,
  type WorkerExecutionContext,
} from "./index"

describe("stateFileRequest", () => {
  it("accepts catalog states and hashed viewer artifacts", () => {
    expect(stateFileRequest("/api/states/tx/unit-stats.abc123.arrow")).toEqual({
      file: "unit-stats.abc123.arrow",
      key: "tx/unit-stats.abc123.arrow",
      state: "tx",
    })
    expect(stateFileRequest("/api/states/de-cd119/manifest.json")?.key).toBe(
      "de-cd119/manifest.json",
    )
    expect(stateFileRequest("/api/states/tx-precincts/manifest.json")?.key).toBe(
      "tx-precincts/manifest.json",
    )
  })

  it("rejects unknown states, nested files, and traversal", () => {
    expect(stateFileRequest("/api/states/dc/manifest.json")).toBeNull()
    expect(stateFileRequest("/api/states/tx/subdir/file.json")).toBeNull()
    expect(stateFileRequest("/api/states/tx/%2e%2e.json")).toBeNull()
  })
})

describe("parseByteRange", () => {
  it("parses explicit, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ length: 10, offset: 10 })
    expect(parseByteRange("bytes=90-", 100)).toEqual({ length: 10, offset: 90 })
    expect(parseByteRange("bytes=-12", 100)).toEqual({ length: 12, offset: 88 })
  })

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(parseByteRange("items=0-1", 100)).toBeNull()
    expect(parseByteRange("bytes=100-101", 100)).toBeNull()
    expect(parseByteRange("bytes=20-10", 100)).toBeNull()
  })
})

describe("public artifact responses", () => {
  it("allows public viewers to read manifests across origins", async () => {
    const object = {
      httpEtag: '"manifest"',
      httpMetadata: { contentType: "application/json" },
      size: 128,
    }
    const response = await worker.fetch(
      new Request("https://wasm-ar-beta.dillonr.ing/api/states/tx/manifest.json", {
        method: "HEAD",
      }),
      {
        ASSETS: { fetch: () => Promise.reject(new Error("unexpected asset request")) },
        TILE_BUCKET: {
          get: async () => null,
          head: async () => object,
        },
      } satisfies WasmArBetaEnv,
      { waitUntil: () => undefined } satisfies WorkerExecutionContext,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-expose-headers")).toContain("content-range")
  })
})
