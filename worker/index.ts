/**
 * Serves the standalone viewer and its read-only state artifacts. Inputs are
 * GET/HEAD requests for a supported block-group or precinct dataset; outputs
 * stream R2 objects with byte-range and immutable-cache semantics or delegate
 * to static assets.
 */
import { states } from "../web/src/catalog"

const knownStates = new Set(
  states.flatMap((state) => [state.slug, `${state.slug}-precincts`]),
)

type AssetBinding = {
  fetch(request: Request): Promise<Response>
}

type R2ObjectMetadata = {
  httpEtag: string
  httpMetadata?: {
    contentEncoding?: string
    contentType?: string
  }
  range?: object
  size: number
}

type R2ObjectBody = R2ObjectMetadata & {
  body: ReadableStream<Uint8Array>
}

type R2BucketBinding = {
  get(key: string, options?: { range: Headers }): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2ObjectMetadata | null>
}

export type WasmArBetaEnv = {
  ASSETS: AssetBinding
  TILE_BUCKET: R2BucketBinding
}

export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
}

const worker = {
  async fetch(
    request: Request,
    env: WasmArBetaEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname
      const stateFile = stateFileRequest(pathname)
      if (!stateFile) {
        if (pathname.startsWith("/api/")) {
          return secureJson({ error: "Not found" }, 404)
        }
        return env.ASSETS.fetch(request)
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return secureJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" })
      }
      return await serveStateFile(request, env, ctx, stateFile)
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "WASM auto-redistrict viewer request failed",
        path: new URL(request.url).pathname,
      }))
      return secureJson({ error: "Internal server error" }, 500)
    }
  },
}

export default worker

export type StateFileRequest = {
  file: string
  key: string
  state: string
}

export function stateFileRequest(pathname: string): StateFileRequest | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const match = /^\/api\/states\/([a-z0-9][a-z0-9-]*)\/([^/]+)$/i.exec(decoded)
  if (!match) return null
  const state = match[1]?.toLowerCase() ?? ""
  const file = match[2] ?? ""
  if (!knownStates.has(state)) return null
  if (file.includes("..") || !/^[a-z0-9][a-z0-9._-]*\.(json|arrow|pmtiles)$/i.test(file)) {
    return null
  }
  return { file, key: `${state}/${file}`, state }
}

export function parseByteRange(rangeHeader: string | null, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader ?? "")
  if (!match) return null
  const start = match[1] ?? ""
  const end = match[2] ?? ""
  if (!start && !end) return null
  if (!start) {
    const suffixLength = Math.min(Number(end), size)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    return { length: suffixLength, offset: size - suffixLength }
  }
  const offset = Number(start)
  if (!Number.isFinite(offset) || offset < 0 || offset >= size) return null
  const endOffset = end ? Math.min(Number(end), size - 1) : size - 1
  if (!Number.isFinite(endOffset) || endOffset < offset) return null
  return { length: endOffset - offset + 1, offset }
}

async function serveStateFile(
  request: Request,
  env: WasmArBetaEnv,
  ctx: WorkerExecutionContext,
  stateFile: StateFileRequest,
) {
  const rangeHeader = request.headers.get("range")
  const cacheable = request.method === "GET" && !rangeHeader && !stateFile.file.endsWith(".pmtiles")
  const cacheRequest = new Request(clearSearch(request.url), { method: "GET" })
  if (cacheable) {
    const defaultCache = (caches as CacheStorage & { default: Cache }).default
    const cached = await defaultCache.match(cacheRequest).catch(() => undefined)
    if (cached) return cached
  }

  if (request.method === "HEAD" && !rangeHeader) {
    const object = await env.TILE_BUCKET.head(stateFile.key)
    if (!object) return secureJson({ error: "State artifact not found" }, 404)
    return new Response(null, { headers: objectHeaders(stateFile.file, object) })
  }

  const object = await env.TILE_BUCKET.get(
    stateFile.key,
    rangeHeader ? { range: request.headers } : undefined,
  )
  if (!object) return secureJson({ error: "State artifact not found" }, 404)
  const response = new Response(request.method === "HEAD" ? null : object.body, {
    headers: objectHeaders(stateFile.file, object, rangeHeader),
    status: rangeHeader && object.range ? 206 : 200,
  })
  if (cacheable) {
    const defaultCache = (caches as CacheStorage & { default: Cache }).default
    ctx.waitUntil(
      defaultCache.put(cacheRequest, response.clone()).catch((error: unknown) => {
        console.error(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          key: stateFile.key,
          message: "Viewer R2 cache write failed",
        }))
      }),
    )
  }
  return response
}

function objectHeaders(
  file: string,
  object: R2ObjectMetadata,
  rangeHeader?: string | null,
) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-length, content-range, etag",
    "cache-control": cacheControl(file),
    "content-type": object.httpMetadata?.contentType ?? contentType(file),
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  })
  if (object.httpMetadata?.contentEncoding) {
    headers.set("content-encoding", object.httpMetadata.contentEncoding)
  }
  const parsedRange = rangeHeader ? parseByteRange(rangeHeader, object.size) : null
  if (parsedRange && object.range) {
    headers.set("content-length", String(parsedRange.length))
    headers.set(
      "content-range",
      `bytes ${parsedRange.offset}-${parsedRange.offset + parsedRange.length - 1}/${object.size}`,
    )
  } else {
    headers.set("content-length", String(object.size))
  }
  return headers
}

function cacheControl(file: string) {
  return file === "manifest.json"
    ? "public, max-age=60, stale-while-revalidate=300"
    : "public, max-age=31536000, immutable"
}

function contentType(file: string) {
  if (file.endsWith(".arrow")) return "application/vnd.apache.arrow.stream"
  if (file.endsWith(".pmtiles")) return "application/octet-stream"
  return "application/json"
}

function clearSearch(rawUrl: string) {
  const url = new URL(rawUrl)
  url.search = ""
  return url
}

function secureJson(
  body: Record<string, string>,
  status: number,
  extraHeaders: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: {
      ...extraHeaders,
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}
