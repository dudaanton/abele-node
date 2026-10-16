import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { adapter } from '../trace/adapter.js'
import * as programs from '../../packages/node-core/src/debugger/programs.js'
import { ChannelError } from '@abele/channel-protocol'

it('starts without a chat, lists chat and folder sessions together, and restarts with breakpoints', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'debug-folder-')))
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  const runs: DapSession[] = []
  const closes: (() => void)[] = []
  const closedSessions = new Set<string>()
  const configs: unknown[] = []
  const core = new NodeCore(join(dir, 'state'), {
    debuggerEnabled: true,
    debuggerProfile: (core) => ({
      profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
      async launch(config, target, sources) {
        configs.push(config)
        const w = wire()
        const fake = adapter(w, () => ({}), dir)
        const session = new DapSession(core.debugger, core.debugger.create(target), w.dap, sources)
        runs.push(session)
        const close = () => {
          closedSessions.add(session.id)
          fake.stop()
          w.dap.close()
        }
        closes.push(close)
        return {
          root: session,
          onSession(listener) {
            listener(session)
            return () => {}
          },
          async close() {
            close()
          },
        }
      },
      async attach(config, target, sources) {
        configs.push(config)
        const w = wire()
        const fake = adapter(w, () => ({}), dir)
        const session = new DapSession(core.debugger, core.debugger.create(target), w.dap, sources)
        runs.push(session)
        const close = () => {
          closedSessions.add(session.id)
          fake.stop()
          w.dap.close()
        }
        closes.push(close)
        return {
          root: session,
          onSession(listener) {
            listener(session)
            return () => {}
          },
          async close() {
            close()
          },
        }
      },
    }),
  })
  const owner = core.authority.authenticate(core.createToken('fixture').token)
  // This fixture is an ordinary folder. Repository discovery is outside this test.
  vi.spyOn(core.resources.git, 'text').mockRejectedValue(new ChannelError('git_failed'))
  const discovery = vi
    .spyOn(programs, 'inspectorPrograms')
    .mockResolvedValue([
      { pid: 123, port: 9229, command: 'node app.js', cwd: dir, script: join(dir, 'app.js') },
    ])
  const startedAt = vi.spyOn(programs, 'processStartedAt').mockResolvedValue(Date.now() - 10000)
  const request = async (method: string, p: any) =>
    (await core.request(owner, method, p, p.operation_id ?? crypto.randomUUID())) as any
  try {
    const project = await request('project.register', { path: dir, trust: 'trusted' })
    const [workspace] = await request('workspace.list', { project_id: project.project_id })
    const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
    await expect(
      request('debugger.v1.start', { operation_id: 'unapproved', folder, program: 'app.js' })
    ).rejects.toThrow('unauthorized')
    await request('project.execution', {
      project_id: project.project_id,
      target: folder,
      enabled: true,
    })
    const first = await request('debugger.v1.start', {
      operation_id: 'start',
      folder,
      program: 'app.js',
      argv: ['one'],
    })
    expect(runs[0]!.snapshot.target.conversation_id).toBeNull()
    const chat = await request('session.create', { provider: 'fake', target: folder })
    const second = await request('debugger.v1.start', {
      operation_id: 'chat',
      conversation_id: chat.session_id,
      program: 'app.js',
    })
    const state = runs[0]!.snapshot
    const grantInput = {
      installation_id: owner.installation_id,
      run_id: 'run',
      task_id: 'task',
      conversation_id: chat.session_id,
      workspace_id: state.target.workspace_id,
      target_id: state.target.target_id,
      debug_session_id: first.debug_session_id,
      incarnation: state.incarnation,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      actions: ['read'],
    }
    const grant = core.debuggerControl.createGrant(owner, grantInput)
    const agent = {
      kind: 'agent' as const,
      authority: owner,
      grant_id: grant.grant_id,
      run_id: 'run',
      task_id: 'task',
      conversation_id: chat.session_id,
      workspace_id: state.target.workspace_id,
      target_id: state.target.target_id,
    }
    expect(
      core.debuggerControl.read(agent, 'status', { debug_session_id: first.debug_session_id })
        .snapshot.debug_session_id
    ).toBe(first.debug_session_id)
    core.debugger.recordHistory(first.debug_session_id, {
      actor: { kind: 'human', principal_id: owner.installation_id },
      operation_id: 'values',
      operation: 'variables',
      outcome: 'completed',
      requested_data: { answer: 42 },
    })
    expect(
      core.debuggerControl.read(agent, 'history', { debug_session_id: first.debug_session_id })
        .entries[0].requested_data
    ).toEqual({ answer: 42 })
    expect(() => core.debuggerControl.permissions.authorize(agent, state, 'step')).toThrow(
      'unauthorized'
    )
    for (const method of ['start', 'attachProgram', 'programs', 'sessions', 'restart']) {
      expect(() =>
        core.request({ installation_id: 'unpaired' }, `debugger.v1.${method}`, { folder })
      ).toThrow('unauthorized')
    }
    const other = await request('project.register', {
      path: join(dir, 'state'),
      trust: 'trusted',
      exact_root: true,
    })
    const [otherWorkspace] = await request('workspace.list', { project_id: other.project_id })
    await request('project.execution', {
      project_id: other.project_id,
      target: { kind: 'workspace', workspace_id: otherWorkspace.workspace_id },
      enabled: true,
    })
    const otherChat = await request('session.create', {
      provider: 'fake',
      target: { kind: 'workspace', workspace_id: otherWorkspace.workspace_id },
    })
    await expect(
      request('debugger.v1.start', {
        operation_id: 'mismatched',
        folder,
        conversation_id: otherChat.session_id,
        program: 'app.js',
      })
    ).rejects.toThrow('debugger_owner_mismatch')
    expect(() =>
      core.debuggerControl.createGrant(owner, {
        ...grantInput,
        conversation_id: otherChat.session_id,
      })
    ).toThrow('stale_state')
    const listed = await request('debugger.v1.sessions', { folder })
    expect(listed.map((s: any) => s.debug_session_id).sort()).toEqual(
      [first.debug_session_id, second.debug_session_id].sort()
    )
    expect(
      (await request('debugger.v1.sessions', { conversation_id: chat.session_id })).map(
        (s: any) => s.debug_session_id
      )
    ).toEqual([second.debug_session_id])
    core.debugger.patchBreakpoints(
      first.debug_session_id,
      0,
      [{ breakpoint_id: 'bp', source_id: 's1', line: 1 }],
      []
    )
    closes[0]!()
    const restarted = await request('debugger.v1.restart', {
      operation_id: 'restart',
      debug_session_id: first.debug_session_id,
    })
    expect(configs[2]).toEqual(configs[0])
    expect(core.debugger.snapshot(restarted.debug_session_id).snapshot.breakpoints).toMatchObject([
      { breakpoint_id: 'bp', line: 1 },
    ])
    expect(
      await request('debugger.v1.restart', {
        operation_id: 'restart',
        debug_session_id: first.debug_session_id,
      })
    ).toEqual(restarted)
    await expect(
      request('debugger.v1.restart', {
        operation_id: 'active',
        debug_session_id: restarted.debug_session_id,
      })
    ).rejects.toThrow('debugger_session_active')
    expect((await request('debugger.v1.programs', { folder })).programs).toMatchObject([
      { pid: 123, in_chat_folder: true },
    ])
    const attached = await request('debugger.v1.attachProgram', {
      operation_id: 'attach',
      folder,
      pid: 123,
      port: 9229,
    })
    expect(runs[3]!.snapshot.target).toMatchObject({
      conversation_id: null,
      process_ownership: 'external',
    })
    closes[3]!()
    const reattached = await request('debugger.v1.restart', {
      operation_id: 'reattach',
      debug_session_id: attached.debug_session_id,
    })
    expect(reattached.debug_session_id).not.toBe(attached.debug_session_id)
    expect(configs[4]).toEqual(configs[3])
    const running = runs[2]!.snapshot
    core.debugger.observe(running.debug_session_id, running.incarnation, {
      kind: 'lifecycle',
      lifecycle: 'terminated',
    })
    const afterExit = await request('debugger.v1.restart', {
      operation_id: 'after-exit',
      debug_session_id: running.debug_session_id,
    })
    expect(core.debugger.snapshot(afterExit.debug_session_id).snapshot.breakpoints).toMatchObject([
      { breakpoint_id: 'bp', line: 1 },
    ])
    expect(closedSessions.has(running.debug_session_id)).toBe(true)
  } finally {
    discovery.mockRestore()
    startedAt.mockRestore()
    await core.debuggerLaunches.close()
    for (const close of closes) close()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
