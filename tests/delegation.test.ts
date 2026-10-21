import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'

const cleanup: (() => void)[] = []
it('does not revive a revoked controller relationship when the owner continues a retained child', async () => {
  const f = fixture()
  const child = await f.create()
  f.core.tick()
  f.request('delegation.grant.revoke', { grant_id: child.grant_id })
  f.request('session.send', {
    session_id: child.session_id,
    text: 'owner work',
    observed_seq: f.core.head(child.session_id),
  })
  f.core.tick()
  expect(
    JSON.parse(
      String(
        f.core.db
          .prepare('SELECT body FROM delegations WHERE delegation_id=?')
          .get(child.delegation_id)!.body
      )
    ).state
  ).toBe('completed')
  expect(
    f.core
      .read(child.session_id, 0)
      .some((e) => e.type === 'content.delta' && (e.data as any).text === 'owner work')
  ).toBe(true)
})
it('lets a parent delete a completed child by delegation identity with a replayable receipt', async () => {
  const f = fixture()
  const child = await f.create()
  expect(() =>
    f.request('delegation.delete', { delegation_id: child.delegation_id }, 'delete')
  ).toThrow('resource_busy')
  f.core.tick()
  const deleted = f.request('delegation.delete', { delegation_id: child.delegation_id }, 'delete')
  expect(deleted).toEqual({ session_id: child.session_id, deleted: true })
  f.restart()
  expect(f.request('delegation.delete', { delegation_id: child.delegation_id }, 'delete')).toEqual(
    deleted
  )
  expect(f.request('session.list', {})).toEqual([])
})
it('delivers a long pi final report in ordered mailbox parts without losing its beginning', async () => {
  const f = fixture()
  const child = await f.create('long-report', [{ kind: 'hang' }])
  f.core.tick()
  const input = f.core.db
    .prepare('SELECT * FROM inputs WHERE session_id=?')
    .get(child.session_id) as any
  const text = 'Beginning\n' + 'report '.repeat(9000) + '\nEnd'
  f.core.transaction(() => {
    f.core.delegations.observe(child.session_id, input.run_id, {
      type: 'pi.message.final',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
    f.core.transition(input, 'completed')
  })
  f.core.tick()
  expect(
    f.core
      .read(child.mailbox_stream_id, 0)
      .filter((e) => e.type === 'delegation.result')
      .map((e) => (e.data as any).text)
      .join('')
  ).toBe(text)
})
it('reports a deadline as stopped with a resumable time-limit reason', async () => {
  const f = fixture()
  const child = await f.create('deadline', [{ kind: 'hang' }])
  f.core.tick()
  const input = f.core.db
    .prepare('SELECT * FROM inputs WHERE session_id=?')
    .get(child.session_id) as any
  f.core.transaction(() => {
    f.core.transition(input, 'delivery_unknown')
    f.core.append(
      child.session_id,
      'run.interrupted',
      { kind: 'node' },
      { run_id: input.run_id, reason: 'deadline' }
    )
  })
  f.core.tick()
  expect(f.request('delegation.status', { delegation_id: child.delegation_id })).toMatchObject({
    state: 'stopped',
    reason: 'time_limit',
  })
})
it('keeps delegated prompts waiting and announces them in the parent mailbox', async () => {
  const f = fixture()
  const child = await f.create('prompt', [{ kind: 'permission', ttl_ms: 1 }])
  f.core.tick()
  expect(f.core.prompts(child.session_id)[0]!.expires_at).toBe(Number.MAX_SAFE_INTEGER)
  const status = f.request('delegation.status', { delegation_id: child.delegation_id })
  expect(status.pending_prompts[0].prompt_id).toBe(f.core.prompts(child.session_id)[0]!.prompt_id)
  expect(
    f.core
      .read(child.mailbox_stream_id, 0)
      .some(
        (e) => e.type === 'delegation.question' && (e.data as any).report_id.startsWith('prompt:')
      )
  ).toBe(true)
  const prompt = f.core.prompts(child.session_id)[0]!
  f.core.delegations.promptOpened(child.session_id, { ...prompt, prompt_id: 'next-permission' })
  const questions = f.core
    .read(child.mailbox_stream_id, 0)
    .filter((e) => e.type === 'delegation.question')
  expect(questions).toHaveLength(1)
  expect((questions[0]!.data as any).text).not.toContain(child.session_id)
  expect((questions[0]!.data as any).text).not.toContain(prompt.prompt_id)
  f.core.db
    .prepare('INSERT INTO obsidian_tool_invocations VALUES(?,?,?,?,?)')
    .run('hosted-approval', child.session_id, prompt.run_id, 'hosted-call', '{}')
  f.core.delegations.promptOpened(child.session_id, {
    ...prompt,
    prompt_id: 'hosted-prompt',
    run_id: 'obsidian:hosted-approval',
  })
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.question')
  ).toHaveLength(1)
  f.core.delegations.promptOpened(child.session_id, {
    ...prompt,
    prompt_id: 'extension-question',
    kind: 'input',
  })
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.question')
  ).toHaveLength(2)
})
it.each(['completed', 'failed', 'cancelled', 'unknown', 'stopped'] as const)(
  'continues a %s child in the same session',
  async (state) => {
    const f = fixture()
    const child = await f.create()
    f.core.tick()
    f.core.db
      .prepare('UPDATE inputs SET state=? WHERE session_id=?')
      .run(
        state === 'unknown' ? 'delivery_unknown' : state === 'stopped' ? 'interrupted' : state,
        child.session_id
      )
    f.core.db
      .prepare('UPDATE delegations SET body=? WHERE delegation_id=?')
      .run(JSON.stringify({ ...child, state }), child.delegation_id)
    const params = {
      delegation_id: child.delegation_id,
      text: 'review follow-up',
      observed_seq: f.core.head(child.session_id),
    }
    const sent = f.request('delegation.send', params, 'follow-up')
    expect(sent.input_id).toBeTruthy()
    f.restart()
    expect(f.request('delegation.send', params, 'follow-up')).toEqual(sent)
    f.core.tick()
    expect(f.request('delegation.status', { delegation_id: child.delegation_id }).state).toBe(
      'completed'
    )
    const results = f.core
      .read(child.mailbox_stream_id, 0)
      .filter((e) => e.type === 'delegation.result')
    expect((results.at(-1)?.data as any)?.text).toBe('review follow-up')
  }
)
it('advertises Codex alongside the other providers', () => {
  const f = fixture()
  expect(f.core.capabilities().providers.map((p) => p.provider)).toContain('codex')
  expect(f.request('node.describe', {}).providers.map((p: any) => p.provider)).toContain('codex')
})
it('does not reuse an earlier explicit result for a queued follow-up', async () => {
  const f = fixture()
  const child = await f.create('queued', [{ kind: 'permission' }, { kind: 'echo' }])
  f.core.tick()
  const prompt = f.core.prompts(child.session_id)[0]!
  f.core.delegations
    .reporter(child.session_id, prompt.run_id)
    .report({ report_id: 'first', kind: 'result', text: 'Earlier report' })
  f.request('delegation.send', {
    delegation_id: child.delegation_id,
    text: 'New result',
    observed_seq: f.core.head(child.session_id),
  })
  f.request('prompt.answer', {
    session_id: child.session_id,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    revision: prompt.revision,
    action_digest: prompt.action_digest,
    choice: 'allow',
  })
  f.core.tick()
  f.core.tick()
  expect(
    f.core
      .read(child.mailbox_stream_id, 0)
      .filter((e) => e.type === 'delegation.result')
      .map((e) => e.data as any)
      .at(-1)?.text
  ).toBe('New result')
})
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
it('refuses active-child deletion and preserves completed delegation history after chat deletion/restart', async () => {
  const f = fixture()
  const child = await f.create()
  const p = { session_id: child.session_id }
  expect(() => f.request('session.delete', p, 'delete-child')).toThrow('resource_busy')
  f.core.tick()
  const status = f.request('delegation.status', { delegation_id: child.delegation_id })
  expect(status.state).toBe('completed')
  const deleted = f.request('session.delete', p, 'delete-child')
  f.restart()
  expect(f.request('session.delete', p, 'delete-child')).toEqual(deleted)
  expect(f.request('session.list', {})).toEqual([])
  expect(f.request('delegation.status', { delegation_id: child.delegation_id })).toEqual({
    ...status,
    session_head_seq: status.session_head_seq + 1, // The deletion is an additional audit event.
  })
  expect(
    f.core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.result')
  ).toHaveLength(1)
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
it('refuses a delegated turn whose displayed target is no longer bound', async () => {
  const f = fixture()
  const child = await f.create('guarded', [{ kind: 'hang' }])
  const params = {
    delegation_id: child.delegation_id,
    text: 'not here',
    observed_seq: 0,
    expected_target: {
      target: { kind: 'worktree', worktree_id: 'formerly-bound' },
      incarnation: 'old',
    },
  }
  const receipt = await f.request('delegation.send', params, 'guarded-child')
  expect(receipt).toEqual({ code: 'target_changed', current_target: null })
  expect(await f.request('delegation.send', params, 'guarded-child')).toEqual(receipt)
  expect(f.core.read(child.session_id, 0).filter((e) => e.type === 'input.accepted')).toHaveLength(
    1
  )
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
