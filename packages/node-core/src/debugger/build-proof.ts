import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'

/** Re-emit in an isolated thread: never execute project scripts or write compiler output. */
export function compilerBuildProof(root: string, source: string, map: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sibling = new URL('./build-proof-worker.js', import.meta.url)
    const worker = new Worker(
      existsSync(sibling)
        ? sibling
        : new URL('../../dist/debugger/build-proof-worker.js', import.meta.url),
      {
        workerData: { root, source, map },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      }
    )
    const timer = setTimeout(() => {
      void worker.terminate()
      resolve(false)
    }, 10000)
    worker.once('message', (matched) => {
      clearTimeout(timer)
      resolve(matched === true)
    })
    worker.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    worker.once('exit', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}
