import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { adapter } from '../trace/adapter.js'
import * as programs from '../../packages/node-core/src/debugger/programs.js'
import * as processIdentity from '../../packages/node-core/src/debugger/process.js'
import { ChannelError } from '@abele/channel-protocol'
import { DebuggerClient } from '@abele/node-client'

it('starts without a chat, lists chat and folder sessions together, and restarts with breakpoints', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'debug-folder-')))
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'late.js'), 'console.log(2)\n')
  writeFileSync(join(dir, 'late.ts'), 'const n: number = 2\n')
  writeFileSync(join(dir, 'unit.test.ts'), 'test()\n')
  writeFileSync(join(dir, 'auto.generated.ts'), 'generated()\n')
  writeFileSync(join(dir, 'types.d.ts'), 'export interface Item { id: string }\n')
  symlinkSync('late.js', join(dir, 'alias.js'))
  symlinkSync('..', join(dir, 'escape'))
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
        const session = new DapSession(
          core.debugger,
          core.debugger.create(target),
          w.dap,
          new Map(sources)
        )
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
  const identity = vi
    .spyOn(processIdentity, 'processStartIdentity')
    .mockResolvedValue('fixture-identity')
  const listeners = vi
    .spyOn(programs, 'applicationListeners')
    .mockResolvedValue([{ pid: 123, ports: [4399] }])
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
      stop_on_entry: false,
    })
    expect(configs[0]).toMatchObject({ stop_on_entry: false })
    expect(runs[0]!.snapshot.target.conversation_id).toBeNull()
    expect(core.debuggerControl.methods()).toContain('debugger.v1.addSources')
    const added = await request('debugger.v1.addSources', {
      operation_id: 'add',
      debug_session_id: first.debug_session_id,
      sources: [
        'late.js',
        'alias.js',
        'late.ts',
        '../outside.js',
        'escape',
        'unit.test.ts',
        'auto.generated.ts',
        'types.d.ts',
      ],
    })
    expect(added).toEqual({
      incarnation: runs[0]!.incarnation,
      sources: [
        { source_id: 's2', path: 'late.js' },
        { source_id: 's2', path: 'late.js' },
      ],
      refused: [
        { path: 'late.ts', code: 'debugger_source_no_map' },
        { path: '../outside.js', code: 'debugger_source_outside_folder' },
        { path: 'escape', code: 'debugger_source_outside_folder' },
        { path: 'unit.test.ts', code: 'debugger_source_test' },
        { path: 'auto.generated.ts', code: 'debugger_source_generated' },
        { path: 'types.d.ts', code: 'debugger_source_declaration' },
      ],
    })
    expect(runs[0]!.sources.get('s2')).toBe(join(dir, 'late.js'))
    expect(
      (
        await request('debugger.v1.addSources', {
          operation_id: 'again',
          debug_session_id: first.debug_session_id,
          sources: ['late.js'],
        })
      ).sources
    ).toEqual([{ source_id: 's2', path: 'late.js' }])
    await request('project.execution', {
      project_id: project.project_id,
      target: folder,
      enabled: false,
    })
    await expect(
      request('debugger.v1.addSources', {
        operation_id: 'revoked',
        debug_session_id: first.debug_session_id,
        sources: ['late.js'],
      })
    ).rejects.toThrow('unauthorized')
    await request('project.execution', {
      project_id: project.project_id,
      target: folder,
      enabled: true,
    })
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
    for (const method of [
      'start',
      'attachProgram',
      'addSources',
      'programs',
      'sessions',
      'restart',
    ]) {
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
      [{ breakpoint_id: 'bp', source_id: 's2', line: 1 }],
      []
    )
    core.trace.points.set(first.debug_session_id, [{ breakpoint_id: 'bp', take: ['n'] }], [])
    await runs[0]!.syncBreakpoints()
    closes[0]!()
    const restarted = await request('debugger.v1.restart', {
      operation_id: 'restart',
      debug_session_id: first.debug_session_id,
    })
    expect(core.trace.points.list(restarted.debug_session_id)).toEqual([
      { breakpoint_id: 'bp', take: ['n'] },
    ])
    expect(configs[2]).toEqual(configs[0])
    expect(restarted.sources).toContainEqual({ source_id: 's2', path: 'late.js' })
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
    const [attached, simultaneous] = await Promise.all(
      ['attach', 'attach-simultaneous'].map((operation_id) =>
        request('debugger.v1.attachProgram', { operation_id, folder, pid: 123, port: 9229 })
      )
    )
    expect(simultaneous.debug_session_id).toBe(attached.debug_session_id)
    expect(runs).toHaveLength(4)
    expect(
      await request('http.v1.destination', {
        project_id: project.project_id,
        url: 'http://localhost:4399/events',
      })
    ).toMatchObject({ debug_session_id: attached.debug_session_id, reason: 'owned' })
    for (const host of ['127.0.0.1', '[::1]']) {
      expect(
        await request('http.v1.destination', {
          project_id: project.project_id,
          url: `http://${host}:4399/events`,
        })
      ).toMatchObject({ debug_session_id: attached.debug_session_id, reason: 'owned' })
    }
    identity.mockResolvedValue('reused-process-identity')
    expect(
      await request('http.v1.destination', {
        project_id: project.project_id,
        url: 'http://localhost:4399/events',
      })
    ).toMatchObject({ debug_session_id: null, reason: 'unobserved' })
    identity.mockResolvedValue('fixture-identity')
    await expect(
      request('http.v1.send', {
        project_id: project.project_id,
        url: 'http://localhost:4399/events',
        method: 'GET',
        headers: [],
        secrets: [],
        route_by_destination: true,
        debug_session_id: first.debug_session_id,
      })
    ).rejects.toThrow('http_recording_owner_mismatch')
    expect(
      await request('http.v1.destination', {
        project_id: project.project_id,
        url: 'http://example.invalid:4399/events',
      })
    ).toMatchObject({ debug_session_id: null, reason: 'remote' })
    listeners.mockResolvedValue([{ pid: 999, ports: [4399] }])
    expect(
      await request('http.v1.destination', {
        project_id: project.project_id,
        url: 'http://localhost:4399/events',
      })
    ).toMatchObject({ debug_session_id: null, reason: 'unobserved' })
    listeners.mockResolvedValue([{ pid: 123, ports: [4399] }])
    const duplicates = await Promise.all(
      ['duplicate-1', 'duplicate-2'].map((operation_id) =>
        request('debugger.v1.attachProgram', { operation_id, folder, pid: 123, port: 9229 })
      )
    )
    expect(duplicates.map((x) => x.debug_session_id)).toEqual([
      attached.debug_session_id,
      attached.debug_session_id,
    ])
    writeFileSync(
      join(dir, 'late.js.map'),
      JSON.stringify({ sources: ['late.ts'], sourcesContent: ['const n: number = 2\n'] })
    )
    const mapped = await request('debugger.v1.addSources', {
      operation_id: 'mapped',
      debug_session_id: attached.debug_session_id,
      sources: ['late.ts'],
    })
    expect(mapped.refused).toEqual([])
    const sourceQuery = {
      debug_session_id: attached.debug_session_id,
      source_id: mapped.sources[0].source_id,
      line: 1,
      end_line: 2,
    }
    const typedDebugger = new DebuggerClient(request)
    expect(
      await request('debugger.v1.addSources', {
        operation_id: 'runtime-evidence-required',
        debug_session_id: attached.debug_session_id,
        sources: ['late.ts'],
        require_loaded: true,
      })
    ).toMatchObject({
      sources: [],
      refused: [{ path: 'late.ts', code: 'debugger_source_unverified' }],
    })
    expect(await typedDebugger.sourceStatus(sourceQuery)).toMatchObject({
      loaded: null,
      known: false,
      items: [],
    })
    await expect(request('debugger.v1.breakpointLocations', sourceQuery)).rejects.toThrow(
      'unsupported_operation'
    )
    expect(
      await request('debugger.v1.sessionInfo', { debug_session_id: attached.debug_session_id })
    ).toMatchObject({ started_at: expect.any(String) })
    writeFileSync(join(dir, 'late.ts'), 'changed\n')
    await expect(typedDebugger.sourceStatus(sourceQuery)).rejects.toThrow('debugger_source_changed')
    expect(
      (
        await request('debugger.v1.addSources', {
          operation_id: 'mapped-changed',
          debug_session_id: attached.debug_session_id,
          sources: ['late.ts'],
        })
      ).refused
    ).toEqual([{ path: 'late.ts', code: 'debugger_source_changed' }])
    writeFileSync(join(dir, 'late.ts'), 'const n: number = 2\n')
    expect(
      (
        await request('debugger.v1.addSources', {
          operation_id: 'mapped-restored',
          debug_session_id: attached.debug_session_id,
          sources: ['late.ts'],
        })
      ).refused
    ).toEqual([])
    expect(runs[3]!.snapshot.target).toMatchObject({
      conversation_id: null,
      process_ownership: 'external',
    })
    utimesSync(join(dir, 'late.js'), new Date(0), new Date(0))
    expect(
      await request('debugger.v1.addSources', {
        operation_id: 'attach-add',
        debug_session_id: attached.debug_session_id,
        sources: ['late.js', 'app.js'],
      })
    ).toMatchObject({
      sources: [{ source_id: 's2', path: 'late.js' }],
      refused: [{ path: 'app.js', code: 'debugger_source_changed' }],
    })
    for (const [operation_id, text, refused] of [
      ['identical-js', 'console.log(2)\n', false],
      ['changed-js', 'console.log(3)\n', true],
      ['restored-js', 'console.log(2)\n', false],
    ] as const) {
      writeFileSync(join(dir, 'late.js'), text)
      const result = await request('debugger.v1.addSources', {
        operation_id,
        debug_session_id: attached.debug_session_id,
        sources: ['late.js'],
      })
      expect(result.refused).toEqual(
        refused ? [{ path: 'late.js', code: 'debugger_source_changed' }] : []
      )
    }
    closes[3]!()
    const reattached = await request('debugger.v1.restart', {
      operation_id: 'reattach',
      debug_session_id: attached.debug_session_id,
    })
    expect(reattached.debug_session_id).not.toBe(attached.debug_session_id)
    expect(configs[4]).toEqual(configs[3])
    const previousAttach = runs[4]!
    const attachSource = reattached.sources.find((s: any) => s.path === 'late.ts')!
    core.debugger.patchBreakpoints(
      previousAttach.id,
      previousAttach.snapshot.breakpoint_revision,
      [
        {
          breakpoint_id: 'retained-disabled',
          source_id: attachSource.source_id,
          line: 1,
          condition: 'false',
          enabled: false,
        },
      ],
      []
    )
    core.trace.points.set(
      previousAttach.id,
      [{ breakpoint_id: 'retained-disabled', take: ['n'] }],
      []
    )
    await previousAttach.syncBreakpoints()
    closes[4]!()
    discovery.mockResolvedValue([
      { pid: 456, port: 9230, command: 'node app.js', cwd: dir, script: join(dir, 'app.js') },
    ])
    const nextProcess = await request('debugger.v1.attachProgram', {
      operation_id: 'new-process',
      folder,
      pid: 456,
      port: 9230,
    })
    expect(core.debugger.snapshot(nextProcess.debug_session_id).snapshot.breakpoints).toMatchObject(
      [{ breakpoint_id: 'retained-disabled', line: 1, condition: 'false', enabled: false }]
    )
    expect(core.trace.points.list(nextProcess.debug_session_id)).toEqual([
      { breakpoint_id: 'retained-disabled', take: ['n'] },
    ])
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
    cpSync(new URL('../fixtures/debugger-outdir/', import.meta.url), join(dir, 'typed'), {
      recursive: true,
    })
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', join(dir, 'typed')])
    const typed = await request('debugger.v1.start', {
      operation_id: 'typed-start',
      folder,
      program: 'typed/dist/bin/courier.js',
      sources: ['typed/src/bin/courier.ts', 'typed/src/services/orders.ts'],
    })
    expect(typed.sources.map((s: any) => s.path)).toEqual([
      'typed/dist/bin/courier.js',
      'typed/src/bin/courier.ts',
      'typed/src/services/orders.ts',
    ])
    const late = await request('debugger.v1.addSources', {
      operation_id: 'typed-add',
      debug_session_id: typed.debug_session_id,
      sources: ['typed/src/services/late.ts'],
    })
    expect(late.refused).toEqual([])
    expect(late.sources).toEqual([{ source_id: 's4', path: 'typed/src/services/late.ts' }])
    discovery.mockResolvedValue([
      {
        pid: 123,
        port: 9229,
        command: 'node dist/bin/courier.js',
        cwd: join(dir, 'typed'),
        script: join(dir, 'typed/dist/bin/courier.js'),
      },
    ])
    startedAt.mockResolvedValue(Date.now() + 10000)
    const typedAttach = await request('debugger.v1.attachProgram', {
      operation_id: 'typed-attach',
      folder,
      pid: 123,
      port: 9229,
      sources: ['typed/src/bin/courier.ts', 'typed/src/services/orders.ts'],
    })
    expect(typedAttach.sources).toEqual(typed.sources)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/page.ts'), 'export const answer: number = 42\n')
    writeFileSync(
      join(dir, 'caller.js.map'),
      JSON.stringify({
        sources: ['src/page.ts'],
        sourcesContent: ['export const answer: number = 42\n'],
      })
    )
    const callerSession = runs.at(-1)!
    core.debugger.observe(callerSession.id, callerSession.incarnation, {
      kind: 'stopped',
      thread_id: 1,
      all_threads_stopped: true,
      reason: 'exception',
      hit_breakpoint_ids: [],
    })
    const callers = await callerSession.stack(1)
    expect(callers.items[0]).toMatchObject({
      relative_path: 'src/page.ts',
      source_id: 's4',
      line: 4,
    })
    expect(callers.items[1]).toMatchObject({ source_id: null })
    expect(callers.items[1]).not.toHaveProperty('relative_path')
    const liveId = typedAttach.debug_session_id
    expect(await request('debugger.v1.exitInfo', { debug_session_id: liveId })).toEqual({
      exit_code: null,
    })
    callerSession.recordExit(9)
    expect(await request('debugger.v1.exitInfo', { debug_session_id: liveId })).toEqual({
      exit_code: 9,
    })
    expect(
      (await request('debugger.v1.status', { debug_session_id: liveId })).snapshot
    ).not.toHaveProperty('exit_code')
    for (let i = 0; i < 130; i++) {
      const old = core.debugger.create(runs.at(-1)!.snapshot.target)
      core.debugger.observe(old.debug_session_id, old.incarnation, {
        kind: 'lifecycle',
        lifecycle: 'detached',
      })
    }
    const firstPage = await request('debugger.v1.sessions', { folder, limit: 1 })
    expect(firstPage[0].lifecycle).not.toBe('detached')
    expect(
      (await request('debugger.v1.sessions', { folder })).some(
        (s: any) => s.debug_session_id === liveId
      )
    ).toBe(true)
  } finally {
    discovery.mockRestore()
    startedAt.mockRestore()
    identity.mockRestore()
    listeners.mockRestore()
    await core.debuggerLaunches.close()
    for (const close of closes) close()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
