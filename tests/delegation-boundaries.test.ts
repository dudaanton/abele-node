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
  const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-boundary-'))
  let core = new NodeCore(dir)
  const actor = core.authority.authenticate(core.createToken('owner').token)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const request = (method: string, p: unknown, op: string = crypto.randomUUID()) =>
    core.request(actor, method, p, op) as any
  const grant = request('delegation.grant.create', {
    parent_id: 'parent',
    project_ids: [],
    allow_fake: true,
  })
  const params = {
    grant_id: grant.grant_id,
    delegation_key: 'key',
    title: 'task',
    provider: 'fake',
    text: 'task',
  }
  return {
    get core() {
      return core
    },
    actor,
    request,
    params,
    grant,
    restart() {
      core.close()
      core = new NodeCore(dir)
    },
  }
}
it('recovers response loss and rolls back child/link/mailbox/receipt together before commit', async () => {
  const f = fixture()
  f.core.fault = (p) => {
    if (p === 'after_commit') throw Error('lost response')
  }
  await expect(f.request('delegation.create', f.params, 'lost')).rejects.toThrow('lost response')
  f.restart()
  const child = await f.request('delegation.create', f.params, 'fresh-operation')
  expect((f.core.db.prepare('SELECT count(*) AS n FROM sessions').get() as any).n).toBe(1)
  expect(await f.request('delegation.create', f.params, 'lost')).toEqual(child)
  f.core.fault = (p) => {
    if (p === 'before_commit') throw Error('fault')
  }
  await expect(
    f.request('delegation.create', { ...f.params, delegation_key: 'other' })
  ).rejects.toThrow('fault')
  f.restart()
  expect((f.core.db.prepare('SELECT count(*) AS n FROM delegations').get() as any).n).toBe(1)
  expect(
    (
      f.core.db
        .prepare("SELECT count(*) AS n FROM streams WHERE stream_id LIKE 'delegation/%'")
        .get() as any
    ).n
  ).toBe(1)
})
it('accepts run-fenced structured reports once and only publishes a final result after provider completion', async () => {
  const f = fixture()
  const child = await f.request('delegation.create', {
    ...f.params,
    script: [{ kind: 'permission' }, { kind: 'echo' }],
  })
  f.core.tick()
  const prompt = f.core.prompts(child.session_id)[0]!
  const reporter = f.core.delegations.reporter(child.session_id, prompt.run_id)
  const progress = { report_id: 'x'.repeat(128), kind: 'progress', text: 'half done' }
  expect(reporter.tool().execute(progress)).toEqual({ recorded: true })
  expect(reporter.report(progress)).toEqual({ recorded: true })
  expect(() => reporter.report({ ...progress, text: 'changed' })).toThrow(/idempotency_mismatch/)
  reporter.report({ report_id: 'question', kind: 'question', text: 'Which direction?' })
  reporter.report({ report_id: 'result', kind: 'result', text: 'Explicit final summary' })
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.progress')
  ).toHaveLength(1)
  expect(f.core.read(child.mailbox_stream_id, 0).some((e) => e.type === 'delegation.result')).toBe(
    false
  )
  expect(f.core.prompt(prompt.prompt_id).state).toBe('pending')
  expect(() =>
    reporter.report({ report_id: 'bad', kind: 'result', text: 'x', session_id: 'spoof' })
  ).toThrow(/invalid_params/)
  expect(() => f.core.delegations.reporter(child.session_id, 'old-run').report(progress)).toThrow(
    /stale_revision/
  )
  f.request('prompt.answer', {
    session_id: child.session_id,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    revision: prompt.revision,
    action_digest: prompt.action_digest,
    choice: 'allow',
  })
  f.core.tick()
  expect(
    f.core.read(child.mailbox_stream_id, 0).find((e) => e.type === 'delegation.result')?.data
  ).toHaveProperty('text', 'Explicit final summary')
  expect(() => reporter.report(progress)).toThrow(/unauthorized|stale_revision/)
  const status = f.request('delegation.status', { delegation_id: child.delegation_id })
  expect(status.session_head_seq).toBe(f.core.head(child.session_id))
  expect(status.mailbox_head_seq).toBe(f.core.head(child.mailbox_stream_id))
  // Humans can continue the ordinary child session after the delegation has closed.
  f.request('session.send', {
    session_id: child.session_id,
    text: 'human followup',
    observed_seq: status.session_head_seq,
  })
  f.core.tick()
  expect(
    f.core
      .read(child.session_id, 0)
      .some((e) => e.type === 'content.delta' && (e.data as any).text === 'human followup')
  ).toBe(true)
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.result')
  ).toHaveLength(1)
})
it('cannot widen approved actions/providers or read after revocation of the approving owner', async () => {
  const f = fixture()
  const other = f.core.authority.authenticate(f.core.createToken('controller').token)
  const grant = f.request('delegation.grant.create', {
    installation_id: other.installation_id,
    parent_id: 'parent',
    project_ids: [],
    providers: ['fake'],
    allow_fake: true,
    actions: ['create', 'status', 'read'],
  })
  const child = (await f.core.request(
    other,
    'delegation.create',
    { ...f.params, grant_id: grant.grant_id },
    'create'
  )) as any
  expect(() =>
    f.core.request(
      other,
      'delegation.send',
      { delegation_id: child.delegation_id, text: 'next', observed_seq: 0 },
      'send'
    )
  ).toThrow(/unauthorized/)
  await expect(
    f.core.request(
      other,
      'delegation.create',
      { ...f.params, grant_id: grant.grant_id, delegation_key: 'wrong-provider', provider: 'pi' },
      'wrong'
    )
  ).rejects.toThrow(/unauthorized/)
  f.core.revokeToken(f.actor.installation_id)
  expect(() =>
    f.core.request(other, 'stream.read', { stream_id: child.mailbox_stream_id, after_seq: 0 })
  ).toThrow(/unauthorized/)
  f.core.tick()
  expect(f.core.delegations).toBeDefined()
  expect(
    (f.core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(child.session_id) as any)
      .state
  ).toBe('cancelled')
})
