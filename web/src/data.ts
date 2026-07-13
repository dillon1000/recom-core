/**
 * Owns the browser-side data-worker lifecycle. Inputs are state slugs; outputs
 * are complete graph bundles and phase updates. A newer load terminates the
 * previous worker immediately so large-state parsing never races the UI.
 */
import DataWorker from "./data.worker?worker"
import type { EnsembleBaseline, GraphInput, Manifest, Unit } from "./types"

export type LoadedState = {
  graph: GraphInput
  baseline?: EnsembleBaseline
  initialAssignment: Uint16Array
  manifest: Manifest
  units: Unit[]
  virtualEdges: number
}

type Response =
  | { type: "progress"; requestId: number; phase: string }
  | ({ type: "complete"; requestId: number } & LoadedState)
  | { type: "error"; requestId: number; error: string }

const dataOrigin = (import.meta.env.VITE_DATA_ORIGIN ?? "https://wasm-ar-beta.dillonr.ing")
  .replace(/\/$/, "")
let activeWorker: Worker | null = null
let requestId = 0

export function loadState(slug: string, onProgress: (phase: string) => void) {
  activeWorker?.terminate()
  const worker = new DataWorker()
  activeWorker = worker
  requestId += 1
  const currentRequest = requestId

  return new Promise<LoadedState>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<Response>) => {
      const message = event.data
      if (message.requestId !== currentRequest) return
      if (message.type === "progress") {
        onProgress(message.phase)
        return
      }
      worker.terminate()
      if (activeWorker === worker) activeWorker = null
      if (message.type === "complete") {
        resolve(message)
      } else {
        reject(new Error(message.error))
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      if (activeWorker === worker) activeWorker = null
      reject(new Error(event.message || "The state data worker failed."))
    }
    worker.postMessage({ type: "load", requestId: currentRequest, slug, dataOrigin })
  })
}

export function publicAssetUrl(slug: string, rawUrl: string) {
  const file = new URL(rawUrl, dataOrigin).pathname.split("/").at(-1)
  if (!file || !/^[a-z0-9][a-z0-9._-]*$/i.test(file)) throw new Error(`Invalid asset URL: ${rawUrl}`)
  return `${dataOrigin}/api/states/${slug}/${file}`
}
