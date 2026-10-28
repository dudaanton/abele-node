import { watch as nativeWatch, type FSWatcher } from 'node:fs'

let watch: typeof nativeWatch = nativeWatch
let state: unknown
const watchers = new Map<number, FSWatcher>()
const send = (message: object) => {
  if (process.connected) process.send!(message)
}
// Serialize startup with open commands: a test factory may need an async import.
let queue = Promise.resolve()
process.on('message', (message: any) => {
  queue = queue
    .then(async () => {
      const { id } = message
      if (message.kind === 'init') {
        if (message.factory) watch = (await import(message.factory)).watch
        state = message.state
        send({ kind: 'started', execPath: process.execPath, version: process.version })
      } else if (message.kind === 'close') {
        watchers.get(id)?.close()
        watchers.delete(id)
      } else if (message.kind === 'open') {
        send({ kind: 'opening', id, path: message.path, recursive: message.recursive })
        const watcher = (watch as any)(
          message.path,
          { recursive: message.recursive },
          (event: string, name: string | Buffer | null) =>
            send({ kind: 'change', id, event, name: name === null ? null : String(name) }),
          state
        )
        watchers.set(id, watcher)
        watcher.on('error', (error: Error) => send({ kind: 'error', id, error: error.message }))
        send({ kind: 'ready', id })
      }
    })
    .catch((error) =>
      send({
        kind: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    )
})
// Parent death must not leave an ownerless native watcher process behind.
process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'))
