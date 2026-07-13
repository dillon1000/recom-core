/**
 * Runs recom-core in a dedicated worker. Inputs are transfer-owned CSR buffers,
 * a deterministic seed, and bounded proposal parameters; outputs are chunked
 * progress plus compact proposal deltas, periodic checkpoints, and the final
 * sampled assignment. Termination is the immediate cancellation boundary.
 */
import initializeWasm, { Chain } from "./wasm/recom_core"
import wasmUrl from "./wasm/recom_core_bg.wasm?url"
import type {
  ChainStatus,
  ProposalTraceBatch,
  WorkerRequest,
  WorkerResponse,
} from "./types"

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
    const { initialAssignment: requestedInitialAssignment, steps, ...params } = request.params
    chain = new Chain(
      new Uint32Array(graph.offsets),
      new Uint32Array(graph.neighbors),
      new Uint8Array(graph.edgeCountyCross),
      graph.edgeWeights ? new Uint32Array(graph.edgeWeights) : null,
      new Uint32Array(graph.populations),
      {
        ...params,
        frozenDistricts: new Uint16Array(),
        ...(requestedInitialAssignment
          ? { initialAssignment: new Uint16Array(requestedInitialAssignment) }
          : {}),
      },
    )
    const initialAssignment = chain.assignment()
    let completed = 0
    let status = chain.step(0) as ChainStatus
    const initialScore = status.currentScore
    while (completed < steps) {
      const count = Math.min(chunkSize, steps - completed)
      const batch = chain.step_traced(count) as ProposalTraceBatch
      status = batch.status
      completed += count
      const changedNodes = Uint32Array.from(batch.changedNodes)
      const changedDistricts = Uint16Array.from(batch.changedDistricts)
      const checkpoint = chain.assignment()
      self.postMessage(
        {
          type: "progress",
          requestId: request.requestId,
          completed,
          status,
          trace: {
            proposals: batch.proposals,
            changedNodes,
            changedDistricts,
            checkpoint,
          },
        } satisfies WorkerResponse,
        { transfer: [changedNodes.buffer, changedDistricts.buffer, checkpoint.buffer] },
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    // Generation exposes the seeded chain endpoint. The separately tracked
    // best assignment remains available for a future explicit optimization
    // mode instead of pinning random seeds to a strong reference plan.
    const assignment = chain.assignment()
    const bestAssignment = chain.best_assignment()
    const frontier = chain.frontier() as ChainStatus["currentScore"][]
    const response: WorkerResponse = {
      type: "complete",
      requestId: request.requestId,
      assignment,
      bestAssignment,
      initialAssignment,
      initialScore,
      frontier,
      status,
    }
    self.postMessage(response, {
      transfer: [assignment.buffer, bestAssignment.buffer, initialAssignment.buffer],
    })
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
