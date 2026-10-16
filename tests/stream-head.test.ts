import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { validateParams } from '../packages/node-protocol/src/index.js'

// A client opening a long session starts at its end: it asks where the journal ends, subscribes
// near there, and reads older pages backwards only when the person scrolls up.
const dirs: string[] = [],
  cores: NodeCore[] = []
function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/stream-head-'))
  dirs.push(dir)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  return { core, actor, request }
}
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('says where a stream ends, so a client can start at its tail and page backwards', async () => {
  const s = setup()
  const session = await s.request('session.create', { title: 'Sample', provider: 'fake' })
  const head = s.core.head(session.session_id)
  expect(head).toBeGreaterThan(0)
  expect(await s.request('stream.head', { stream_id: session.session_id })).toEqual({
    head_seq: head,
  })
  // The last page before the head, read as a client scrolling up would.
  const page = await s.request('stream.read', {
    stream_id: session.session_id,
    after_seq: Math.max(0, head - 1),
    limit: 1,
  })
  expect(page.map((e: { seq: number }) => e.seq)).toEqual([head])
})

it('refuses an unknown stream as reading it would, and validates its parameters strictly', async () => {
  const s = setup()
  await expect(s.request('stream.head', { stream_id: 'sample-missing' })).rejects.toThrow(
    'not_found'
  )
  expect(() => validateParams('stream.head', { stream_id: 'x', extra: 1 })).toThrow()
})
