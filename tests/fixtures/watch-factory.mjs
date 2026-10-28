import { EventEmitter } from 'node:events'
import { pbkdf2Sync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function watch(_path, _options, listener, dir) {
  const load = (index) => {
    try {
      return Number(readFileSync(join(dir, String(index)), 'utf8'))
    } catch {
      return 0
    }
  }
  const add = (index) => writeFileSync(join(dir, String(index)), String(load(index) + 1))
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  add(0)
  while (load(4) === 1) sleep()
  const watcher = new EventEmitter()
  let generation = load(3)
  const timer = setInterval(() => {
    const next = load(3)
    if (next !== generation) {
      generation = next
      listener('change', 'file')
    }
  }, 5)
  watcher.close = () => {
    clearInterval(timer)
    add(1)
    // Native calls cannot be interrupted by Worker.terminate().
    if (load(2) === 2) pbkdf2Sync('close', 'native', 8000000, 32, 'sha256')
    while (load(2) === 1) sleep()
  }
  return watcher
}
