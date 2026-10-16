import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeCore, GitRunner } from '@abele/node-core'
import type { ProviderAdapter } from '../../packages/node-core/src/providers.js'
import { target } from './helpers.js'

it.each(['completed', 'pending'] as const)(
  'the real scheduler supplies actual run scope and settles tools without waiting for queued follow-up input (LSP refresh %s)',
  async (refreshState) => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-run-')),
      folder = join(dir, 'folder')
    mkdirSync(folder)
    // This exercises provider scheduling, not Git provisioning or OS process probes.
    const git = join(dir, 'fake-git')
    writeFileSync(git, '#!/bin/sh\nexit 1\n')
    chmodSync(git, 0o700)
    let core!: NodeCore,
      owner: any,
      finish!: (result: any) => void,
      grant: any,
      debug: any,
      sleeper!: Promise<any>
    const calls: string[] = []
    const provider: ProviderAdapter = {
      available: true,
      configuration: {},
      capabilities: () => ({ provider: 'claude', available: true }),
      configurationForTurn: () => ({}),
      reconcile: async () => {},
      async startTurn(turn, sink) {
        calls.push(turn.run_id)
        debug = core.debugger.create({
          ...target,
          conversation_id: turn.session_id,
          workspace_id: core.session(turn.session_id).workspace_id ?? null,
        })
        core.debugger.observe(debug.debug_session_id, debug.incarnation, {
          kind: 'lifecycle',
          lifecycle: 'active',
        })
        grant = core.debuggerControl.createGrant(owner, {
          installation_id: owner.installation_id,
          run_id: turn.run_id,
          task_id: 'actual-task',
          conversation_id: turn.session_id,
          workspace_id: debug.target.workspace_id,
          target_id: debug.target.target_id,
          debug_session_id: debug.debug_session_id,
          incarnation: debug.incarnation,
          expires_at: new Date(Date.now() + 60000).toISOString(),
          actions: ['read'],
        })
        const done = new Promise<any>((resolve) => {
          finish = resolve
        })
        sleeper = sink.debugger!.call('debug_sleep', {
          debug_session_id: debug.debug_session_id,
          duration_ms: 60000,
        })
        void sleeper.then(() => finish({ result: { subtype: 'success', is_error: false } }))
        return {
          done,
          interrupt: async () => {
            finish({ reason: 'interrupted' })
          },
        }
      },
    }
    core = new NodeCore(join(dir, 'state'), {
      debuggerEnabled: true,
      claude: provider,
      git: new GitRunner(15000, 512 * 1024, git),
    })
    owner = core.authority.authenticate(core.createToken('owner').token)
    const request = (m: string, p: unknown) => core.request(owner, m, p, crypto.randomUUID())
    let finishRefresh!: () => void
    const refreshDone = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    if (refreshState === 'completed') finishRefresh()
    // Run settlement starts an independent LSP refresh. Its Git watchdog (when a server
    // exists on PATH) is not a debugger timer, and completion must not depend on its I/O.
    const refresh = vi.spyOn(core.resources.lsp, 'afterEdit').mockReturnValue(refreshDone)
    try {
      const project: any = await request('project.register', { path: folder, trust: 'trusted' })
      const [workspace]: any = await request('workspace.list', { project_id: project.project_id })
      const executionTarget = { kind: 'workspace', workspace_id: workspace.workspace_id }
      await request('project.execution', {
        project_id: project.project_id,
        target: executionTarget,
        enabled: true,
      })
      const session: any = await request('session.create', {
        provider: 'claude',
        title: 'Debugger investigation',
        target: executionTarget,
      })
      vi.useFakeTimers()
      request('session.send', {
        session_id: session.session_id,
        text: 'investigate',
        observed_seq: 0,
      })
      await core.execution.drain()
      expect(calls).toHaveLength(1)
      request('session.send', {
        session_id: session.session_id,
        text: 'queued next input',
        observed_seq: core.head(session.session_id),
      })
      expect(
        core.db.prepare("SELECT count(*) AS n FROM inputs WHERE state='queued'").get()?.n
      ).toBe(1)
      expect(vi.getTimerCount()).toBe(2) // sleep deadline and grant expiry
      core.debugger.observe(debug.debug_session_id, debug.incarnation, {
        kind: 'stopped',
        thread_id: 1,
        all_threads_stopped: true,
        reason: 'breakpoint',
        hit_breakpoint_ids: ['human-bp'],
      })
      expect(await sleeper).toMatchObject({ reason: 'event', snapshot: { execution: 'stopped' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(core.debuggerControl.permissions.grant(grant.grant_id).revoked).toBe(true)
      expect(core.db.prepare('SELECT state FROM provider_runs').get()?.state).toBe('settled')
      expect(calls).toHaveLength(1)
      expect(
        core.db.prepare("SELECT count(*) AS n FROM inputs WHERE state='queued'").get()?.n
      ).toBe(1)
      expect(refresh).toHaveBeenCalledExactlyOnceWith(session.session_id)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      finish?.({ reason: 'interrupted' })
      finishRefresh()
      vi.useRealTimers()
      refresh.mockRestore()
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
