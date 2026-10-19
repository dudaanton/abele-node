import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCore, type LaunchProfile } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from '../debugger/dap-wire.js'
import { adapter } from './adapter.js'

const dirs: string[] = []
const cores: NodeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.debuggerLaunches.close()
    await core.execution.stop()
    await core.resources.stop()
    core.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A profile that "starts" the program over a scripted adapter, as the native one does over a
 * real one: one root session, its sources as given. */
function scriptedProfile(frame: () => Record<string, unknown>) {
  const launched: { config: any; target: any; sources: Map<string, string> }[] = []
  let current: { fake: ReturnType<typeof adapter>; w: ReturnType<typeof wire> } | undefined
  const make =
    (available = true) =>
    (core: NodeCore): LaunchProfile => ({
      profiles: () =>
        available ? [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }] : [],
      async launch(config, target, sources) {
        launched.push({ config, target, sources: new Map(sources) })
        const w = wire()
        const fake = adapter(w, frame, config.cwd)
        current = { fake, w }
        const state = core.debugger.create({ ...target, adapter_version: 'fixture' })
        const root = new DapSession(core.debugger, state, w.dap, sources)
        await root.start('attach', { type: 'pwa-node', port: 1 })
        return {
          root,
          onSession(listener) {
            listener(root)
            return () => {}
          },
          async close() {
            fake.stop()
            w.dap.close()
          },
        }
      },
    })
  return { make, launched, current: () => current! }
}

async function setup(profile: (core: NodeCore) => LaunchProfile) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-launch-')))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(join(folder, 'src/page.js'), 'const result = { items: [1] }\n')
  writeFileSync(join(folder, 'src/service.js'), 'module.exports = {}\n')
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true, debuggerProfile: profile })
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const request = async (method: string, p: any, operation?: string) =>
    (await core.request(
      actor,
      method,
      p,
      operation ?? p.operation_id ?? crypto.randomUUID()
    )) as any
  const project = await request('project.register', { path: folder, trust: 'trusted' })
  const [workspace] = await request('workspace.list', { project_id: project.project_id })
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await request('project.execution', { project_id: project.project_id, target, enabled: true })
  const chat = await request('session.create', { provider: 'fake', target })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
    expect(check()).toBe(true)
  }
  return { core, actor, request, folder, project, target, chat, until }
}

describe('starting a program under the debugger', () => {
  it('starts a program of the chat’s folder and records a run at its record points', async () => {
    const profile = scriptedProfile(() => ({ result: { items: [1, 2] } }))
    const s = await setup(profile.make())
    expect(await s.request('debugger.v1.profiles', {})).toEqual([
      expect.objectContaining({ id: 'js-ts-native' }),
    ])
    const started = await s.request(
      'debugger.v1.start',
      {
        operation_id: 'start-1',
        conversation_id: s.chat.session_id,
        program: 'src/page.js',
        sources: ['src/service.js', 'src/page.js'],
      },
      'start-1'
    )
    expect(started.sources).toEqual([
      { source_id: 's1', path: 'src/page.js' },
      { source_id: 's2', path: 'src/service.js' },
    ])
    expect(profile.launched).toHaveLength(1)
    expect(profile.launched[0]!.config).toEqual({
      cwd: s.folder,
      executable: process.execPath,
      program: join(s.folder, 'src/page.js'),
      argv: [],
      env: {},
    })
    expect(profile.launched[0]!.target).toMatchObject({
      project_id: s.project.project_id,
      conversation_id: s.chat.session_id,
      launch_configuration_id: 'src/page.js',
      process_ownership: 'owned',
      build_identity: 'matched',
    })
    // A retried operation is the same program, not a second one.
    const again = await s.request(
      'debugger.v1.start',
      { operation_id: 'start-1', conversation_id: s.chat.session_id, program: 'src/page.js' },
      'start-1'
    )
    expect(again.debug_session_id).toBe(started.debug_session_id)
    expect(profile.launched).toHaveLength(1)

    const sessions = await s.request('debugger.v1.sessions', {
      conversation_id: s.chat.session_id,
    })
    expect(sessions.map((x: any) => x.debug_session_id)).toEqual([started.debug_session_id])

    // The session answers the panel's ordinary controls: its backend is registered.
    const id = started.debug_session_id
    await s.request('trace.v1.points.set', {
      debug_session_id: id,
      upsert: [{ breakpoint_id: 'bp-1', take: ['result'] }],
      remove: [],
    })
    const { snapshot: snap } = await s.request('debugger.v1.status', { debug_session_id: id })
    const receipt = await s.request('debugger.v1.breakpoints.patch', {
      debug_session_id: id,
      incarnation: snap.incarnation,
      expected_state_revision: snap.state_revision,
      operation_id: 'bp-op',
      expected_breakpoint_revision: snap.breakpoint_revision,
      upsert: [{ breakpoint_id: 'bp-1', source_id: 's1', line: 4 }],
      remove: [],
    })
    expect(receipt.outcome).toBe('completed')
    const { fake, w } = profile.current()
    fake.hit([fake.lastBreakpointId()])
    await s.until(() => s.core.trace.recorder.recording(id)?.steps === 1)
    await s.until(() => fake.running)

    // The program ends: the run is kept and the session no longer takes commands.
    w.dap.close()
    await s.until(
      () =>
        s.core.debugger.snapshot(id).snapshot.lifecycle === 'connection-lost' &&
        !s.core.trace.recorder.recording(id)
    )
    const { snapshot: after } = await s.request('debugger.v1.status', { debug_session_id: id })
    await expect(
      s.request('debugger.v1.pause', {
        debug_session_id: id,
        incarnation: after.incarnation,
        expected_state_revision: after.state_revision,
        operation_id: 'pause-after',
        thread_id: 1,
      })
    ).rejects.toThrow()
    const runs = await s.request('trace.v1.runs', { project_id: s.project.project_id })
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0].steps).toBe(1)
  })

  it('answers with the session the program runs in, which the adapter starts under its own', async () => {
    let child: DapSession | undefined
    const make = (core: NodeCore): LaunchProfile => ({
      profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
      async launch(config, target, sources) {
        const parent = wire(),
          inner = wire()
        adapter(parent, () => ({}), config.cwd)
        adapter(inner, () => ({}), config.cwd)
        const root = new DapSession(
          core.debugger,
          core.debugger.create(target),
          parent.dap,
          sources
        )
        await root.start('attach', { type: 'pwa-node', port: 1 })
        const listeners = new Set<(session: DapSession) => void>()
        setTimeout(async () => {
          child = new DapSession(
            core.debugger,
            core.debugger.create({ ...target, target_id: target.target_id + ':child:1' }),
            inner.dap,
            sources
          )
          for (const listener of listeners) listener(child)
          await child
            .start('attach', { type: 'pwa-node', name: 'program', __pendingTargetId: 'p' })
            .catch(() => {}) // Closed with the run at the end of the test.
        }, 20)
        return {
          root,
          onSession(listener) {
            listener(root)
            listeners.add(listener)
            return () => void listeners.delete(listener)
          },
          program: () =>
            new Promise<DapSession>((resolve) => {
              listeners.add(resolve)
            }),
          async close() {
            parent.dap.close()
            inner.dap.close()
          },
        }
      },
    })
    const s = await setup(make)
    const started = await s.request('debugger.v1.start', {
      operation_id: 'start-child',
      conversation_id: s.chat.session_id,
      program: 'src/page.js',
    })
    expect(child).toBeDefined()
    expect(started.debug_session_id).toBe(child!.id)
    // The program's session takes the panel's controls and record points like any other.
    await s.request('trace.v1.points.set', {
      debug_session_id: child!.id,
      upsert: [{ breakpoint_id: 'bp-1', take: ['result'] }],
      remove: [],
    })
  })

  it('stops the whole run when the program’s own session is stopped, which owns no process itself', async () => {
    let child: DapSession | undefined
    let stopped = 0
    const make = (core: NodeCore): LaunchProfile => ({
      profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
      async launch(config, target, sources) {
        const parent = wire(),
          inner = wire()
        adapter(parent, () => ({}), config.cwd)
        adapter(inner, () => ({}), config.cwd)
        const root = new DapSession(
          core.debugger,
          core.debugger.create(target),
          parent.dap,
          sources
        )
        await root.start('attach', { type: 'pwa-node', port: 1 })
        child = new DapSession(
          core.debugger,
          core.debugger.create({ ...target, target_id: target.target_id + ':child:1' }),
          inner.dap,
          sources
        )
        await child.start('attach', { type: 'pwa-node', name: 'program', __pendingTargetId: 'p' })
        return {
          root,
          onSession(listener) {
            listener(root)
            listener(child!)
            return () => {}
          },
          program: async () => child!,
          async terminate() {
            stopped++
            await child!.detach()
            parent.dap.close()
          },
          async close() {
            parent.dap.close()
            inner.dap.close()
          },
        }
      },
    })
    const s = await setup(make)
    const started = await s.request('debugger.v1.start', {
      operation_id: 'start-stop',
      conversation_id: s.chat.session_id,
      program: 'src/page.js',
    })
    const backend = (s.core.debuggerControl as any).backends.get(started.debug_session_id)
    await backend.dispatch('terminate', { debug_session_id: started.debug_session_id }, () => {})
    expect(stopped).toBe(1)
    expect(s.core.debugger.snapshot(child!.id).snapshot.lifecycle).not.toBe('connection-lost')
  })

  it('reads a program held as js-debug holds it, one thread stopped and no word on the rest, as paused', async () => {
    const profile = scriptedProfile(() => ({}))
    const s = await setup(profile.make())
    const started = await s.request('debugger.v1.start', {
      operation_id: 'start-held',
      conversation_id: s.chat.session_id,
      program: 'src/page.js',
    })
    const id = started.debug_session_id
    const { w, fake } = profile.current()
    fake.threads([0])
    w.send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 0 } })
    w.send({
      type: 'event',
      event: 'stopped',
      body: { threadId: 0, allThreadsStopped: false, reason: 'pause' },
    })
    await s.until(() => s.core.debugger.snapshot(id).snapshot.execution === 'stopped')
    expect(s.core.debugger.snapshot(id).snapshot.thread_inventory).toBe('complete')
  })

  it('takes TypeScript as what runs only through a map of its build that is not older than it', async () => {
    const profile = scriptedProfile(() => ({}))
    const s = await setup(profile.make())
    mkdirSync(join(s.folder, 'dist'))
    writeFileSync(join(s.folder, 'src/total.ts'), 'export const total = 1\n')
    writeFileSync(join(s.folder, 'dist/total.js'), 'exports.total = 1\n')
    // The paths that take breakpoints; one that is not what runs is left out, not the session.
    const start = async () => {
      const started = await s.request('debugger.v1.start', {
        operation_id: crypto.randomUUID(),
        conversation_id: s.chat.session_id,
        program: 'dist/total.js',
        sources: ['src/total.ts'],
      })
      expect(profile.launched.at(-1)!.target.build_identity).toBe('matched')
      return started.sources.map((x: any) => x.path)
    }
    expect(await start()).toEqual(['dist/total.js'])
    const map = { version: 3, file: 'total.js', sources: ['../src/total.ts'], mappings: '' }
    writeFileSync(join(s.folder, 'dist/total.js.map'), JSON.stringify(map))
    expect(await start()).toEqual(['dist/total.js', 'src/total.ts'])
    // The source changed after the build.
    const later = new Date(Date.now() + 60000)
    utimesSync(join(s.folder, 'src/total.ts'), later, later)
    expect(await start()).toEqual(['dist/total.js'])
    // A map that carries the text it was built from is judged by that text.
    writeFileSync(
      join(s.folder, 'dist/total.js.map'),
      JSON.stringify({ ...map, sourcesContent: ['export const total = 1\n'] })
    )
    expect(await start()).toEqual(['dist/total.js', 'src/total.ts'])
    writeFileSync(join(s.folder, 'src/total.ts'), 'export const total = 2\n')
    expect(await start()).toEqual(['dist/total.js'])
    // A program Node does not run as it is proves nothing about its lines.
    await s.request('debugger.v1.start', {
      operation_id: crypto.randomUUID(),
      conversation_id: s.chat.session_id,
      program: 'src/total.ts',
    })
    expect(profile.launched.at(-1)!.target.build_identity).toBe('unknown')
  })

  it('admits mapped sources opened later and refuses stale builds per path', async () => {
    const profile = scriptedProfile(() => ({}))
    const s = await setup(profile.make())
    const started = await s.request('debugger.v1.start', {
      operation_id: 'late-start',
      conversation_id: s.chat.session_id,
      program: 'src/page.js',
    })
    const source = join(s.folder, 'src/late.ts')
    writeFileSync(source, 'export const total = 1\n')
    const add = () =>
      s.request('debugger.v1.addSources', {
        operation_id: crypto.randomUUID(),
        debug_session_id: started.debug_session_id,
        sources: ['src/late.ts'],
      })
    expect((await add()).refused).toEqual([{ path: 'src/late.ts', code: 'debugger_source_no_map' }])
    const map = { version: 3, sources: ['late.ts'], mappings: '' }
    const mapPath = join(s.folder, 'src/page.js.map')
    writeFileSync(mapPath, JSON.stringify(map))
    const later = new Date(Date.now() + 60000)
    utimesSync(source, later, later)
    expect((await add()).refused[0].code).toBe('debugger_source_no_map')
    writeFileSync(mapPath, JSON.stringify({ ...map, sourcesContent: ['export const total = 1\n'] }))
    const results = await Promise.all([add(), add()])
    for (const result of results)
      expect(result.sources).toEqual([{ source_id: 's2', path: 'src/late.ts' }])
    const state = s.core.debugger.snapshot(started.debug_session_id).snapshot
    const receipt = await s.request('debugger.v1.breakpoints.patch', {
      operation_id: 'late-bp',
      debug_session_id: started.debug_session_id,
      incarnation: state.incarnation,
      expected_state_revision: state.state_revision,
      expected_breakpoint_revision: state.breakpoint_revision,
      upsert: [{ breakpoint_id: 'late', source_id: 's2', line: 1 }],
      remove: [],
    })
    expect(receipt.outcome).toBe('completed')
  })

  it('keeps every path inside the chat’s folder', async () => {
    const profile = scriptedProfile(() => ({}))
    const s = await setup(profile.make())
    for (const bad of [
      { program: '../outside.js' },
      { program: 'src/page.js', sources: ['../outside.js'] },
      { program: '/etc/hosts' },
    ])
      await expect(
        s.request('debugger.v1.start', {
          operation_id: crypto.randomUUID(),
          conversation_id: s.chat.session_id,
          ...bad,
        })
      ).rejects.toThrow()
    expect(profile.launched).toHaveLength(0)
  })

  it('starts nothing where the folder may not run code', async () => {
    const profile = scriptedProfile(() => ({}))
    const s = await setup(profile.make())
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target: s.target,
      enabled: false,
    })
    await expect(
      s.request('debugger.v1.start', {
        operation_id: 'start-2',
        conversation_id: s.chat.session_id,
        program: 'src/page.js',
      })
    ).rejects.toThrow(/unauthorized/)
    expect(profile.launched).toHaveLength(0)
  })

  it('refuses plainly while no audited adapter is installed', async () => {
    const s = await setup(scriptedProfile(() => ({})).make(false))
    expect(await s.request('debugger.v1.profiles', {})).toEqual([])
    await expect(
      s.request('debugger.v1.start', {
        operation_id: 'start-3',
        conversation_id: s.chat.session_id,
        program: 'src/page.js',
      })
    ).rejects.toThrow(/debugger_profile_unavailable/)
  })

  it('uses the native profile by default, which lists nothing without an audited adapter', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-launch-')))
    dirs.push(dir)
    const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
    cores.push(core)
    expect(core.debuggerLaunches.profiles()).toEqual([])
  })
})
