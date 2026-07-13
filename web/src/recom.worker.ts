/**
 * Runs recom-core in a dedicated worker. Inputs are transfer-owned CSR buffers,
 * a deterministic seed, and bounded proposal parameters; outputs are chunked
 * progress plus the best one-based assignment. Terminating the worker is the
 * immediate cancellation boundary during synchronous chain construction.
 */
import initializeWasm, { Chain } from "./wasm/recom_core"
import wasmUrl from "./wasm/recom_core_bg.wasm?url"
import type { ChainStatus, WorkerRequest, WorkerResponse } from "./types"

const chunkSize = 200
const ready = initializeWasm({ module_or_path: wasmUrl })

ready.then(
  () => post({ type: "ready", requestId: 0 }),
  (error: unknown) => post({ type: "error", requestId: 0, error: message(error) }),
)

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "run") void run(event.data)
})

async function run(request: WorkerRequest) {
  let chain: Chain | undefined
  try {
    await ready
    const graph = request.graph
    const { initialAssignment, steps, ...params } = request.params
    chain = new Chain(
      new Uint32Array(graph.offsets),
      new Uint32Array(graph.neighbors),
      new Uint8Array(graph.edgeCountyCross),
      new Uint32Array(graph.populations),
      {
        ...params,
        frozenDistricts: new Uint16Array(),
        ...(initialAssignment
          ? { initialAssignment: new Uint16Array(initialAssignment) }
          : {}),
      },
    )
    let completed = 0
    let status = chain.step(0) as ChainStatus
    while (completed < steps) {
      const count = Math.min(chunkSize, steps - completed)
      status = chain.step(count) as ChainStatus
      completed += count
      post({ type: "progress", requestId: request.requestId, completed, status })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const assignment = chain.best_assignment()
    const response: WorkerResponse = {
      type: "complete",
      requestId: request.requestId,
      assignment,
      status,
    }
    self.postMessage(response, { transfer: [assignment.buffer] })
  } catch (error) {
    post({ type: "error", requestId: request.requestId, error: message(error) })
  } finally {
    chain?.free()
  }
}

function post(response: WorkerResponse) {
  self.postMessage(response)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export {}
