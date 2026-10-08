import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { ClientState, ClientStore } from '../packages/node-client/src/index.js'
/** Test-only filesystem adapter: the browser library never imports Node. One installation owns this file. */
export class FileClientStore implements ClientStore {
  private serial: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string) {}
  transaction<T>(work: (state: ClientState) => T | Promise<T>): Promise<T> {
    const task = this.serial.then(async () => {
      const state: ClientState = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, 'utf8'))
        : { cursors: {}, events: {}, outbox: [], results: {} }
      const result = await work(state)
      const temp = this.path + '.tmp',
        fd = openSync(temp, 'w', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(state))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, this.path)
      const dir = openSync(dirname(this.path), 'r')
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
      return structuredClone(result)
    })
    this.serial = task.catch(() => {})
    return task
  }
}
