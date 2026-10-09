import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f()
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-'))
  let core = new NodeCore(dir)
  const auth = core.createToken('parent')
  const actor = core.authority.authenticate(auth.token)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const request = (method: string, params: unknown, operation: string = crypto.randomUUID()) =>
    core.request(actor, method, params, operation) as any
  const grant = request('delegation.grant.create', {
    parent_id: 'plugin-chat',
    project_ids: [],
    allow_fake: true,
  })
  const create = (key = 'task-one', script?: unknown) =>
    request('delegation.create', {
      grant_id: grant.grant_id,
      delegation_key: key,
      title: 'Child',
      provider: 'fake',
      text: 'durable answer',
      ...(script ? { script } : {}),
    })
  return {
    get core() {
      return core
    },
    actor,
    request,
    grant,
    create,
    restart() {
      core.close()
      core = new NodeCore(dir)
    },
  }
}
it('creates once by delegation key across operation IDs and restart, with one offline result and a normal child transcript', async () => {
  const f = fixture()
  const child = await f.create()
  expect(await f.create()).toEqual(child)
  f.core.tick()
  f.restart()
  expect(await f.create()).toEqual(child)
  const events = f.request('stream.read', { stream_id: child.mailbox_stream_id, after_seq: 0 })
  expect(events.filter((e: any) => e.type === 'delegation.result')).toHaveLength(1)
  expect(events.find((e: any) => e.type === 'delegation.result').data.text).toBe('durable answer')
  expect(events.map((e: any) => e.seq)).toEqual(events.map((_: any, i: number) => i + 1))
  expect(f.request('session.get', { session_id: child.session_id }).session_id).toBe(
    child.session_id
  )
  expect(f.core.read(child.session_id, 0).some((e) => e.type === 'content.delta')).toBe(true)
  await expect(
    f.request('delegation.create', {
      grant_id: f.grant.grant_id,
      delegation_key: 'task-one',
      title: 'changed',
      provider: 'fake',
      text: 'changed',
    })
  ).rejects.toThrow(/idempotency_mismatch/)
})
it('isolates mailboxes between delegations and principals, and keeps human permissions out of controller grants', async () => {
  const f = fixture()
  const first = await f.create('one', [{ kind: 'permission' }, { kind: 'echo' }])
  const second = await f.create('two')
  const other = f.core.authority.authenticate(f.core.createToken('other').token)
  expect(() =>
    f.core.request(other, 'stream.read', { stream_id: first.mailbox_stream_id, after_seq: 0 })
  ).toThrow(/unauthorized/)
  expect(() => f.core.authority.check(other, 'subscribe', first.mailbox_stream_id)).toThrow(
    /unauthorized/
  )
  expect(() =>
    f.core.request(other, 'delegation.status', { delegation_id: first.delegation_id })
  ).toThrow(/unauthorized/)
  f.core.tick()
  expect(f.request('delegation.status', { delegation_id: first.delegation_id }).state).toBe(
    'running'
  )
  expect(f.request('delegation.status', { delegation_id: second.delegation_id }).state).toBe(
    'completed'
  )
  expect(f.core.read(first.mailbox_stream_id, 0).some((e) => e.type === 'delegation.result')).toBe(
    false
  )
  const prompt = f.core.prompts(first.session_id)[0]!
  expect(prompt.state).toBe('pending')
  // A human installation still opens/answers a normal child session.
  f.core.request(
    other,
    'prompt.answer',
    {
      session_id: first.session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: prompt.revision,
      action_digest: prompt.action_digest,
      choice: 'allow',
    },
    crypto.randomUUID()
  )
  f.core.tick()
  expect(f.request('delegation.status', { delegation_id: first.delegation_id }).state).toBe(
    'completed'
  )
  expect(
    f.core.read(first.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.result')
  ).toHaveLength(1)
})
it('cancels a blocked child, fails prompts closed, and fences a revoked grant', async () => {
  const f = fixture()
  const child = await f.create('blocked', [{ kind: 'permission' }])
  f.core.tick()
  f.request('delegation.cancel', { delegation_id: child.delegation_id })
  expect(f.core.prompts(child.session_id)[0]!.choice).toBe('deny')
  f.core.tick()
  expect(f.request('delegation.status', { delegation_id: child.delegation_id }).state).toBe(
    'cancelled'
  )
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.terminal')
  ).toHaveLength(1)
  f.request('delegation.grant.revoke', { grant_id: f.grant.grant_id })
  await expect(f.create('after-revoke')).rejects.toThrow(/unauthorized/)
})
