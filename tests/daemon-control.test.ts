import { afterEach, expect, vi } from 'vitest'
import { processIt as it } from './process-test.js'
import { createServer } from 'node:net'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { control, readRuntime, startDaemon } from '../packages/node-daemon/src/index.js'

const directories: string[] = []
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('long state paths have short protected control endpoints, isolated commands, restart and cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abele-control-test-'))
  directories.push(root)
  const state = join(root, 'long-state-'.repeat(15), 'one')
  const otherState = join(root, 'long-state-'.repeat(15), 'two')
  expect(Buffer.byteLength(join(state, 'control.sock'))).toBeGreaterThan(108)
  const first = await startDaemon(state, 0)
  daemons.push(first)
  const second = await startDaemon(otherState, 0)
  daemons.push(second)
  const endpoint = readRuntime(state)!.control_socket!
  const otherEndpoint = readRuntime(otherState)!.control_socket!
  expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100)
  expect(endpoint).not.toBe(otherEndpoint)
  expect(statSync(endpoint).isSocket()).toBe(true)
  expect(statSync(endpoint).mode & 0o777).toBe(0o600)
  expect(statSync(dirname(endpoint)).mode & 0o777).toBe(0o700)
  expect(statSync(dirname(endpoint)).uid).toBe(process.getuid!())
  expect(existsSync(join(state, 'control.sock'))).toBe(false)
  const token = await control(state, { action: 'create', value: 'first' })
  expect(await control(state, { action: 'list' })).toMatchObject([{ label: 'first' }])
  expect(await control(otherState, { action: 'list' })).toEqual([])
  expect(token).toHaveProperty('token')
  await first.stop()
  expect(existsSync(dirname(endpoint))).toBe(false)
  const restarted = await startDaemon(state, 0)
  daemons.push(restarted)
  expect(readRuntime(state)!.control_socket).not.toBe(endpoint)
  expect(await control(state, { action: 'list' })).toMatchObject([{ label: 'first' }])
  const restartedEndpoint = readRuntime(state)!.control_socket!
  await restarted.stop()
  await second.stop()
  expect(existsSync(dirname(restartedEndpoint))).toBe(false)
  expect(existsSync(dirname(otherEndpoint))).toBe(false)
}, 6)

it('daemon startup pins the physical state ancestor for locks, control and shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abele-control-test-'))
  directories.push(root)
  const parent = join(root, 'physical')
  const alias = join(root, 'alias')
  mkdirSync(parent)
  symlinkSync(parent, alias)
  const state = join(alias, 'not-created', 'state')
  const physicalState = join(realpathSync(parent), 'not-created', 'state')
  const daemon = await startDaemon(state, 0)
  daemons.push(daemon)
  expect(readRuntime(physicalState)?.pid).toBe(process.pid)
  const replacement = join(root, 'replacement')
  const replacementState = join(replacement, 'not-created', 'state')
  mkdirSync(replacementState, { recursive: true })
  const sentinel = JSON.stringify({ pid: process.pid, sentinel: 'must survive alias retarget' })
  writeFileSync(join(replacementState, 'daemon.lock'), sentinel)
  rmSync(alias)
  symlinkSync(replacement, alias)
  expect(await control(physicalState, { action: 'list' })).toEqual([])
  await daemon.stop()
  expect(existsSync(join(physicalState, 'daemon.lock'))).toBe(false)
  expect(readFileSync(join(replacementState, 'daemon.lock'), 'utf8')).toBe(sentinel)
})
it('an overlong custom TMPDIR also gets a bounded private endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abele-control-test-'))
  directories.push(root)
  const customTemp = join(root, 'long-temp-'.repeat(15))
  mkdirSync(customTemp)
  vi.stubEnv('TMPDIR', customTemp)
  vi.stubEnv('TMP', customTemp)
  vi.stubEnv('TEMP', customTemp)
  const state = join(root, 'state')
  const daemon = await startDaemon(state, 0)
  daemons.push(daemon)
  const endpoint = readRuntime(state)!.control_socket!
  expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100)
  expect(endpoint.startsWith(customTemp)).toBe(false)
  expect(statSync(dirname(endpoint)).mode & 0o777).toBe(0o700)
  expect(await control(state, { action: 'list' })).toEqual([])
  await daemon.stop()
  expect(existsSync(dirname(endpoint))).toBe(false)
})

it('control remains compatible with the legacy endpoint of an already-running daemon', async () => {
  const state = mkdtempSync(join(tmpdir(), 'abele-old-'))
  directories.push(state)
  writeFileSync(join(state, 'daemon.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.resume()
    socket.once('end', () => socket.end(JSON.stringify({ result: ['legacy'] })))
  })
  try {
    server.listen(join(state, 'control.sock'))
    await once(server, 'listening')
    expect(await control(state, { action: 'list' })).toEqual(['legacy'])
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
