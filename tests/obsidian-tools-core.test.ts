import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const dirs: string[] = []
const cores: NodeCore[] = []
afterEach(() => {
  cores.splice(0).forEach((c) => c.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
function fixture(mode: 'ask' | 'auto' = 'ask') {
  const dir = mkdtempSync(resolve('.scratch/obsidian-core-'))
  dirs.push(dir)
  const core = new NodeCore(dir)
  cores.push(core)
  const token = core.createToken('controller').token
  const actor = core.authority.authenticate(token)
  const session = core.request(
    actor,
    'session.create',
    { provider: 'fake', title: 'vault tools' },
    'create'
  ) as any
  const session_id = session.session_id
  const config = {
    session_id,
    vault_id: 'vault',
    agent_id: 'agent',
    revision: 'r1',
    tools: [{ name: 'create', description: 'Create', inputSchema: { type: 'object' }, mode }],
  }
  const request = (method: string, params: any) =>
    core.request(
      actor,
      'obsidian.tools.v1.' + method,
      params,
      undefined,
      new AbortController().signal
    ) as any
  request('configure', config)
  request('advertise', {
    client_id: 'desktop',
    vault_id: 'vault',
    platform: 'desktop',
    revisions: { agent: 'r1' },
  })
  const call = core.obsidianTools.invoke(actor, session_id, 'run', 'call', 'create', {
    path: 'note',
  })
  request('poll', { client_id: 'desktop' })
  const ref = { invocation_id: call.invocation_id }
  const executor = { ...ref, client_id: 'desktop', revision: 'r1' }
  request('prepare', { ...executor, preview: { text: 'note' } })
  return { dir, core, token, actor, session_id, request, ref, executor, config }
}

it('recovers a real pending prompt after node restart and accepts the existing exact answer API', () => {
  const f = fixture()
  const pending = f.request('get', f.ref)
  const prompt = f.core.prompt(pending.prompt_id)
  expect(prompt.expires_at).toBe(Number.MAX_SAFE_INTEGER)
  f.core.close()
  const core = new NodeCore(f.dir)
  cores.push(core)
  const actor = core.authority.authenticate(f.token)
  expect(core.prompt(prompt.prompt_id).state).toBe('pending')
  core.request(
    actor,
    'prompt.answer',
    {
      session_id: f.session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: prompt.revision,
      action_digest: prompt.action_digest,
      choice: 'allow',
    },
    'answer'
  )
  core.request(
    actor,
    'obsidian.tools.v1.advertise',
    { client_id: 'desktop', vault_id: 'vault', platform: 'desktop', revisions: { agent: 'r1' } },
    undefined,
    new AbortController().signal
  )
  expect(core.request(actor, 'obsidian.tools.v1.claim', f.executor)).toMatchObject({
    execute: true,
  })
  expect(core.prompt(prompt.prompt_id).delivered).toBe(true)
  expect(core.request(actor, 'obsidian.tools.v1.claim', f.executor)).toMatchObject({
    execute: false,
  })
  const completed = {
    ...f.executor,
    state: 'succeeded',
    result: { content: [{ type: 'text', text: 'created' }] },
  }
  expect(core.request(actor, 'obsidian.tools.v1.complete', completed)).toMatchObject({
    state: 'succeeded',
  })
  expect(core.request(actor, 'obsidian.tools.v1.complete', completed)).toMatchObject({
    state: 'succeeded',
  })
})

it('keeps disabled tools disabled in bypass and rejects revised content under an old revision', () => {
  const f = fixture('auto')
  expect(() => f.request('configure', { ...f.config, tools: [] })).toThrow('revision_conflict')
  f.request('configure', {
    ...f.config,
    expected_revision: 'r1',
    revision: 'r2',
    tools: [{ ...f.config.tools[0], mode: 'off' }],
  })
  expect(() => f.request('claim', f.executor)).toThrow('stale_revision')
  expect(() =>
    f.core.obsidianTools.invoke(f.actor, f.session_id, 'run', 'new-call', 'create', {})
  ).toThrow('tool_disabled')
})

it('does not let a reconnecting stale settings writer undo a newer permission snapshot', () => {
  const f = fixture()
  f.request('configure', { ...f.config, expected_revision: 'r1', revision: 'r2', tools: [] })
  expect(() => f.request('configure', f.config)).toThrow('stale_revision')
  expect(() => f.request('configure', { ...f.config, expected_revision: 'r2' })).toThrow(
    'revision_conflict'
  )
})

it('replaces an approval when the executor reports a changed preview', () => {
  const f = fixture()
  const old = f.request('get', f.ref)
  const changed = f.request('prepare', { ...f.executor, preview: { text: 'changed' } })
  expect(changed.prompt_id).not.toBe(old.prompt_id)
  expect(f.core.prompt(old.prompt_id).state).toBe('invalidated')
  expect(f.core.prompt(changed.prompt_id).input?.preview).toEqual({ text: 'changed' })
})

it('cancels pending vault actions atomically when an idle session is deleted', () => {
  const f = fixture()
  f.core.request(f.actor, 'session.delete', { session_id: f.session_id }, 'delete')
  expect(f.request('get', f.ref).state).toBe('cancelled')
})

it.each([false, true])(
  'inherits the parent snapshot before the first delegated input (legacy grant: %s)',
  async (legacyGrant) => {
    const f = fixture()
    const grant = legacyGrant
      ? (f.core.request(
          f.actor,
          'delegation.grant.create',
          {
            parent_id: f.session_id,
            project_ids: [],
            allow_fake: true,
          },
          'grant'
        ) as any)
      : undefined
    const params = {
      ...(grant ? { grant_id: grant.grant_id } : { parent_id: f.session_id }),
      delegation_key: 'vault-child',
      title: 'Child',
      provider: 'fake',
      text: 'first turn',
    }
    const accept = f.core.acceptInput.bind(f.core)
    const admitted: string[] = []
    const spy = vi.spyOn(f.core, 'acceptInput').mockImplementation((actor, input) => {
      const childSession = String(input.session_id)
      expect(f.core.obsidianTools.configured(childSession)).toBe(true)
      const snapshot = f.core.request(f.actor, 'obsidian.tools.v1.configuration', {
        session_id: childSession,
      }) as any
      expect(snapshot.configuration).toEqual({ ...f.config, session_id: childSession })
      const bridge = f.core.obsidianTools.bridge(f.actor, childSession, 'first-run', () => true)
      expect(bridge.tools.map((tool) => tool.name)).toEqual(['obsidian_create'])
      bridge.close()
      admitted.push(childSession)
      return accept(actor, input)
    })
    try {
      const child = (await f.core.request(f.actor, 'delegation.create', params, 'delegate')) as any
      expect(admitted).toEqual([child.session_id])
      const events = f.core.read(child.session_id, 0)
      const configured = events.find((e) => e.type === 'obsidian.tools.configured')!
      expect(configured.seq).toBeLessThan(events.find((e) => e.type === 'input.accepted')!.seq)
      expect(
        f.core.db
          .prepare('SELECT revision FROM obsidian_tool_revisions WHERE session_id=?')
          .get(child.session_id)!.revision
      ).toBe('r1')
      f.request('configure', { ...f.config, revision: 'r2', expected_revision: 'r1', tools: [] })
      expect(await f.core.request(f.actor, 'delegation.create', params, 'delegate-retry')).toEqual(
        child
      )
      expect(
        (
          f.core.request(f.actor, 'obsidian.tools.v1.configuration', {
            session_id: child.session_id,
          }) as any
        ).configuration.revision
      ).toBe('r1')
      expect(admitted).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  }
)

it('rolls back inherited configuration with a failed initial delegation admission', async () => {
  const f = fixture()
  const spy = vi.spyOn(f.core, 'acceptInput').mockImplementation(() => {
    throw new Error('admission failed')
  })
  try {
    await expect(
      f.core.request(
        f.actor,
        'delegation.create',
        {
          parent_id: f.session_id,
          delegation_key: 'failed-child',
          title: 'Child',
          provider: 'fake',
          text: 'first turn',
        },
        'failed-delegate'
      )
    ).rejects.toThrow('admission failed')
    expect(f.core.db.prepare('SELECT count(*) AS n FROM obsidian_tool_config').get()!.n).toBe(1)
    expect(f.core.db.prepare('SELECT count(*) AS n FROM obsidian_tool_revisions').get()!.n).toBe(1)
    expect(f.core.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(1)
  } finally {
    spy.mockRestore()
  }
})

it('accepts an owner-supplied snapshot atomically for a plugin-only parent chat', async () => {
  const f = fixture()
  const { session_id: _parent, ...snapshot } = f.config
  const accept = f.core.acceptInput.bind(f.core)
  const spy = vi.spyOn(f.core, 'acceptInput').mockImplementation((actor, input) => {
    expect(
      (
        f.core.request(actor, 'obsidian.tools.v1.configuration', {
          session_id: input.session_id,
        }) as any
      ).configuration
    ).toEqual({ ...snapshot, session_id: input.session_id })
    return accept(actor, input)
  })
  try {
    const child = (await f.core.request(
      f.actor,
      'delegation.create',
      {
        parent_id: 'plugin-chat',
        delegation_key: 'plugin-child',
        title: 'Child',
        provider: 'fake',
        text: 'first turn',
        obsidian_tools: snapshot,
      },
      'plugin-delegate'
    )) as any
    expect(spy).toHaveBeenCalledOnce()
    const bridge = f.core.obsidianTools.bridge(f.actor, child.session_id, 'first-run', () => true)
    expect(bridge.tools.map((tool) => tool.name)).toEqual(['obsidian_create'])
    bridge.close()
  } finally {
    spy.mockRestore()
  }
})

it('rejects a supplied snapshot that conflicts with the configured parent', async () => {
  const f = fixture()
  const { session_id: _parent, ...snapshot } = f.config
  await expect(
    f.core.request(
      f.actor,
      'delegation.create',
      {
        parent_id: f.session_id,
        delegation_key: 'conflicting-child',
        title: 'Child',
        provider: 'fake',
        text: 'first turn',
        obsidian_tools: { ...snapshot, tools: [] },
      },
      'conflicting-delegate'
    )
  ).rejects.toThrow('stale_revision')
  expect(f.core.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(1)
})
