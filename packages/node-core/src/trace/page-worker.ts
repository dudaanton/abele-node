import { parentPort, workerData } from 'node:worker_threads'
import { TraceStore } from './store.js'
import { traceRunPage, TraceService } from './service.js'
const store = new TraceStore(workerData.root)
parentPort!.on('message', ({ seq, operation, params: p }) => {
  try {
    parentPort!.postMessage({
      seq,
      result:
        operation === 'run'
          ? traceRunPage(store, p.id, p.from, p.limit, p.kinds, p.through)
          : TraceService.readOperation(store, operation, p),
    })
  } catch (error) {
    parentPort!.postMessage({
      seq,
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    })
  }
})
