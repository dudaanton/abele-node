import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore, type ProviderAdapter } from '@abele/node-core'
import { PiApprovalPolicy } from '../packages/provider-pi/src/host.js'
import { CodexProviderAdapter } from '@abele/provider-codex'
import { ClaudeProviderAdapter } from '@abele/provider-claude'
import { sessionUpdatesOf } from '@abele/node-protocol'
import { filesystem } from '../packages/provider-codex/src/policy.js'

it('explicit Codex bypass retains the default-deny generated filesystem policy', () => {
  const workspace = '/fixture/worktree'
  const policy = filesystem({
    workspace,
    sibling: '/fixture',
    state: '/fixture/state',
    home: '/fixture/codex',
  })
  expect(policy['/']).toBe('deny')
  expect(Object.entries(policy).filter(([, mode]) => mode === 'write')).toEqual([
    [workspace, 'write'],
  ])
})

it.each(['pi', 'codex', 'claude'] as const)(
  '%s persists explicit Ask capability on a delegation and session across reconnect',
  async (provider) => {
    const f = await fixture(provider)
    try {
      const child = await f.create('manual')
      const expected = {
        permission_mode: 'manual',
        per_action_approval: provider !== 'codex',
        status: provider === 'codex' ? 'unsupported' : 'supported',
      }
      expect(child.tool_permissions).toMatchObject(expected)
      expect(f.core.session(child.session_id).tool_permissions).toMatchObject(expected)
      expect(f.core.capabilities().capabilities['tool.permissions.v1'].status).toBe('supported')
      expect(
        f.request('session.state', { session_id: child.session_id }).tool_permissions
      ).toMatchObject(expected)
      await f.settle(child.session_id)
      if (provider === 'pi') {
        const raw = f.core.read(child.session_id, 0).find((e) => e.type === 'pi.extension.warning')!
        expect(raw.data).toMatchObject({ capability: 'onTerminalInput', mapped: true })
        expect(sessionUpdatesOf({ ...raw, data: raw.data })).toEqual([])
      }
      if (provider === 'codex') {
        expect(f.started()).toBe(0)
        expect(
          f.core
            .read(child.session_id, 0)
            .some((e) => JSON.stringify(e.data).includes('interactive_approval_unsupported'))
        ).toBe(true)
      }
      await f.reconnect()
      expect(
        f.request('delegation.status', { delegation_id: child.delegation_id }).tool_permissions
      ).toMatchObject(expected)
      expect(f.core.session(child.session_id).tool_permissions).toMatchObject(expected)
      expect(readFileSync(f.outside, 'utf8')).toBe('original')
    } finally {
      await f.close()
    }
  }
)

it.each(['pi', 'codex', 'claude'] as const)(
  '%s bypass is explicit, persisted and passed to the runner',
  async (provider) => {
    const f = await fixture(provider)
    try {
      const child = await f.create('bypassPermissions')
      expect(child.tool_permissions).toMatchObject({
        permission_mode: 'bypassPermissions',
        per_action_approval: provider !== 'codex',
        status: 'supported',
      })
      await f.settle(child.session_id)
      expect(f.modes).toEqual(['bypassPermissions'])
      expect(readFileSync(join(f.cwd!, 'file'), 'utf8')).toBe('edited')
      expect(f.core.prompts(child.session_id).filter((p) => p.state === 'pending')).toEqual([])
      expect(readFileSync(f.outside, 'utf8')).toBe(provider === 'codex' ? 'original' : 'edited')
      await f.reconnect()
      expect(f.core.session(child.session_id).tool_permissions?.permission_mode).toBe(
        'bypassPermissions'
      )
      expect(
        f.request('delegation.status', { delegation_id: child.delegation_id }).tool_permissions
          .permission_mode
      ).toBe('bypassPermissions')
      writeFileSync(join(f.cwd!, 'file'), 'original')
      await f.request('delegation.send', {
        delegation_id: child.delegation_id,
        text: 'edit again',
        observed_seq: f.core.head(child.session_id),
      })
      await f.settle(child.session_id)
      expect(f.modes, JSON.stringify(f.core.read(child.session_id, 0).slice(-8))).toEqual([
        'bypassPermissions',
        'bypassPermissions',
      ])
      expect(readFileSync(join(f.cwd!, 'file'), 'utf8')).toBe('edited')
    } finally {
      await f.close()
    }
  }
)

it('pi Ask waits for each exact edit and cannot edit outside the worktree after denial', async () => {
  const f = await fixture('pi', false)
  try {
    const child = await f.create('manual')
    await f.wait(() => f.core.prompts(child.session_id).length === 1)
    expect(readFileSync(join(f.cwd!, 'file'), 'utf8')).toBe('original')
    f.answer(child.session_id, 'allow')
    await f.wait(() => f.core.prompts(child.session_id).some((p) => p.state === 'pending'))
    expect(readFileSync(join(f.cwd!, 'file'), 'utf8')).toBe('edited')
    expect(readFileSync(f.outside, 'utf8')).toBe('original')
    f.answer(child.session_id, 'deny')
    await f.settle(child.session_id)
    expect(readFileSync(f.outside, 'utf8')).toBe('original')
  } finally {
    await f.close()
  }
})

it('Codex refuses Ask before launching and only accepts explicit operator-enabled bypass', async () => {
  const adapter = new CodexProviderAdapter({
    stateDir: process.cwd(),
    enabled: false,
    allowBypass: true,
  })
  await expect(adapter.startTurn({ permission_mode: 'manual' } as any, {} as any)).rejects.toThrow(
    'interactive_approval_unsupported'
  )
  expect(() => adapter.validateSettings({ permission_mode: 'bypassPermissions' })).not.toThrow()
  expect(() =>
    new CodexProviderAdapter({ stateDir: process.cwd(), enabled: false }).validateSettings({
      permission_mode: 'bypassPermissions',
    })
  ).toThrow()
})

it('Claude Code records the selected native mode and requires operator opt-in for bypass', () => {
  const adapter = new ClaudeProviderAdapter({
    executable: process.env.ABELE_CLAUDE_PATH!,
    allowBypass: true,
  })
  expect(adapter.configurationForTurn({ permission_mode: 'bypassPermissions' })).toMatchObject({
    permission_mode_requested: 'bypassPermissions',
    per_action_approval: true,
  })
  expect(() => adapter.validateSettings({ permission_mode: 'bypassPermissions' })).not.toThrow()
  expect(() =>
    new ClaudeProviderAdapter({ executable: process.env.ABELE_CLAUDE_PATH! }).validateSettings({
      permission_mode: 'bypassPermissions',
    })
  ).toThrow()
})

it('changing an unsupported Codex session to explicit bypass updates its delegation before a follow-up', async () => {
  const f = await fixture('codex')
  try {
    const child = await f.create('manual')
    await f.settle(child.session_id)
    expect(f.started()).toBe(0)
    f.request('session.configure', {
      session_id: child.session_id,
      settings: { permission_mode: 'bypassPermissions' },
    })
    expect(
      f.request('delegation.status', { delegation_id: child.delegation_id }).tool_permissions
    ).toMatchObject({
      permission_mode: 'bypassPermissions',
      status: 'supported',
      per_action_approval: false,
    })
    await f.request('delegation.send', {
      delegation_id: child.delegation_id,
      text: 'edit',
      observed_seq: f.core.head(child.session_id),
    })
    await f.settle(child.session_id)
    expect(f.modes).toEqual(['bypassPermissions'])
    expect(readFileSync(join(f.cwd!, 'file'), 'utf8')).toBe('edited')
  } finally {
    await f.close()
  }
})

it('legacy sessions remain Ask when reconnecting to a node whose default is bypass', async () => {
  const f = await fixture('pi')
  try {
    const child = await f.create('manual')
    await f.settle(child.session_id)
    const legacy: any = { ...f.core.session(child.session_id) }
    delete legacy.tool_permissions
    delete legacy.settings
    f.core.db
      .prepare('UPDATE sessions SET body=? WHERE session_id=?')
      .run(JSON.stringify(legacy), child.session_id)
    f.adapter.sessionDefaults = () => ({
      model: 'default',
      effort: 'high',
      account: 'default',
      permission_mode: 'bypassPermissions',
    })
    await f.reconnect()
    expect(f.core.session(child.session_id).tool_permissions?.permission_mode).toBe('manual')
    expect(
      f.request('session.state', { session_id: child.session_id }).settings.permission_mode
    ).toBe('manual')
    expect(
      f.request('delegation.status', { delegation_id: child.delegation_id }).tool_permissions
        .permission_mode
    ).toBe('manual')
  } finally {
    await f.close()
  }
})

async function fixture(provider: 'pi' | 'codex' | 'claude', autoAnswer = true) {
  const dir = mkdtempSync(resolve('.scratch/tool-policy-')),
    repo = join(dir, 'repo'),
    outside = join(dir, 'outside')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'original')
  writeFileSync(outside, 'original')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const modes: string[] = []
  let started = 0,
    cwd: string | undefined
  const adapter: ProviderAdapter = {
    available: true,
    configuration: {
      permission_ttl_ms: 60000,
      per_action_approval: provider !== 'codex',
      permission_modes: ['manual', 'bypassPermissions'],
    },
    capabilities: () => ({ provider, available: true }),
    configurationForTurn: () => ({}),
    reconcile: async () => {},
    startTurn: async (turn, sink) => {
      started++
      cwd = turn.cwd
      modes.push(turn.permission_mode!)
      if (provider === 'codex')
        sink.event({
          type: 'codex.session.bound',
          data: {
            native_session_id: turn.native_session_id ?? 'fake-thread',
            workspace_path: turn.cwd,
            policy_fingerprint: 'a'.repeat(64),
            model: 'fixture',
          },
        })
      if (provider === 'pi')
        sink.event({
          type: 'pi.extension.warning',
          data: {
            capability: 'onTerminalInput',
            reason: 'unsupported_extension_ui',
          },
        })
      const abort = new AbortController()
      const done = (async () => {
        const policy = new PiApprovalPolicy(sink.permission, abort.signal)
        policy.bypass = turn.permission_mode === 'bypassPermissions'
        for (const [index, path] of [join(turn.cwd, 'file'), outside].entries()) {
          // A fake Codex runner has no OS sandbox: native confinement is checked
          // separately against the actual generated profile, not simulated here.
          if (provider === 'codex' && path === outside) continue
          const denied = await policy.intercept({
            tool_use_id: 'edit-' + index,
            tool_name: 'edit',
            input: { path, text: 'edited' },
          })
          if (!denied) writeFileSync(path, 'edited')
        }
        return { result: { subtype: 'success', is_error: false } }
      })()
      return {
        done,
        interrupt: async () => {
          abort.abort()
          await done
        },
      }
    },
  }
  let core = new NodeCore(join(dir, 'state'), { [provider]: adapter })
  const actor = core.authority.authenticate(core.createToken('owner').token)
  const request = (method: string, params: unknown): any =>
    core.request(actor, method, params, crypto.randomUUID())
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  const answer = (session: string, choice: 'allow' | 'deny') => {
    const p = core.prompts(session).find((p) => p.state === 'pending')!
    request('prompt.answer', {
      session_id: session,
      prompt_id: p.prompt_id,
      run_id: p.run_id,
      revision: p.revision,
      action_digest: p.action_digest,
      choice,
    })
  }
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) {
      core.tick()
      await core.execution.drain()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(condition()).toBe(true)
  }
  const settle = async (session: string) =>
    wait(() => {
      if (autoAnswer)
        for (const p of core.prompts(session)) if (p.state === 'pending') answer(session, 'deny')
      return !core.db
        .prepare(
          "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
        )
        .get(session)
    })
  return {
    get core() {
      return core
    },
    get cwd() {
      return cwd
    },
    outside,
    adapter,
    modes,
    request,
    answer,
    wait,
    settle,
    started: () => started,
    create: async (permission_mode: string) => {
      const child = await request('delegation.create', {
        parent_id: 'parent',
        project_id: project.project_id,
        delegation_key: crypto.randomUUID(),
        provider,
        title: 'permissions',
        text: 'edit',
        permission_mode,
      })
      await core.resources.jobs.drain()
      return child
    },
    reconnect: async () => {
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      core = new NodeCore(join(dir, 'state'), { [provider]: adapter })
    },
    close: async () => {
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
