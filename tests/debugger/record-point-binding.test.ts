import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelError } from '@abele/channel-protocol'
import { NodeCore, type LaunchProfile } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import * as programs from '../../packages/node-core/src/debugger/programs.js'
import * as processes from '../../packages/node-core/src/debugger/process.js'
import * as loaded from '../../packages/node-core/src/debugger/loaded-sources.js'
import { wire } from './dap-wire.js'
import { adapter } from '../trace/adapter.js'

it.each(['attach', 'add', 'start'])(
  'keeps compiled lazy TS pending via %s, then verifies it on load with diagnostics',
  async (admission) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'record-point-binding-')))
    const program = join(dir, 'app.js'),
      source = join(dir, 'lazy.ts')
    const original = 'export const value: number = 42'
    writeFileSync(program, 'setInterval(() => {}, 1000)')
    writeFileSync(source, original)
    const runtime = loaded.emptySourceEvidence()
    runtime.available = true
    runtime.scriptCount = 1
    runtime.scripts.add(program)
    runtime.set(program, createHash('sha256').update('setInterval(() => {}, 1000)').digest('hex'))
    vi.spyOn(loaded, 'loadedSourceDigests').mockImplementation(async () => runtime)
    vi.spyOn(programs, 'inspectorPrograms').mockResolvedValue([
      { pid: 42, port: 9229, command: 'node app.js', cwd: dir, script: program },
    ])
    vi.spyOn(programs, 'processStartedAt').mockResolvedValue(Date.now() + 10000)
    vi.spyOn(processes, 'processStartIdentity').mockResolvedValue('fixture-process')
    const w = wire()
    const fake = adapter(w, () => ({}), dir)
    let session!: DapSession
    const profile = (core: NodeCore): LaunchProfile => ({
      profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
      async launch(_config, target, sources) {
        return this.attach!(
          { address: '127.0.0.1', port: 9229, target_pid: 42 },
          {
            ...target,
            process_evidence: {
              pid: 42,
              ownership_id: 'fixture',
              start_identity: 'fixture-process',
              executable_sha256: 'a'.repeat(64),
            },
          },
          sources,
          dir
        )
      },
      async attach(config, target, sources) {
        session = new DapSession(core.debugger, core.debugger.create(target), w.dap, sources)
        await session.start('attach', { type: 'pwa-node', port: config.port })
        return {
          root: session,
          inspectorPort: 9229,
          onSession(listener) {
            listener(session)
            return () => {}
          },
          async close() {
            fake.stop()
            w.dap.close()
          },
        }
      },
    })
    const core = new NodeCore(join(dir, 'state'), {
      debuggerEnabled: true,
      debuggerProfile: profile,
    })
    vi.spyOn(core.resources.git, 'text').mockRejectedValue(new ChannelError('git_failed'))
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    const request = async (method: string, params: any): Promise<any> =>
      core.request(owner, method, params, params.operation_id ?? crypto.randomUUID())
    try {
      const project = await request('project.register', { path: dir, trust: 'trusted' })
      const [workspace] = await request('workspace.list', { project_id: project.project_id })
      const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
      await request('project.execution', {
        project_id: project.project_id,
        target: folder,
        enabled: true,
      })
      const attached =
        admission === 'start'
          ? await request('debugger.v1.start', {
              operation_id: 'start',
              folder,
              program: 'app.js',
              sources: [],
            })
          : await request('debugger.v1.attachProgram', {
              operation_id: 'attach',
              folder,
              pid: 42,
              port: 9229,
              sources: admission === 'attach' ? ['lazy.ts'] : [],
            })
      if (admission === 'attach')
        expect(attached.sources).toContainEqual({ source_id: expect.any(String), path: 'lazy.ts' })
      const add = (diagnostics = true) =>
        request('debugger.v1.addSources', {
          operation_id: crypto.randomUUID(),
          debug_session_id: attached.debug_session_id,
          sources: ['lazy.ts'],
          ...(diagnostics ? { include_diagnostics: true } : {}),
        })
      const pending = await add()
      expect(await add(false)).not.toHaveProperty('attachment')
      expect(pending.refused).toEqual([])
      expect(pending.sources).toEqual([{ source_id: expect.any(String), path: 'lazy.ts' }])
      expect(pending.attachment).toEqual({
        name: 'app.js',
        pid: 42,
        folder: dir,
        loaded_scripts: 1,
        source_maps: false,
        files: [{ path: 'lazy.ts', loaded: false, mapped: false }],
      })
      await session.patchBreakpoints(
        0,
        [{ breakpoint_id: 'lazy', source_id: pending.sources[0].source_id, line: 1 }],
        []
      )
      expect(session.snapshot.breakpoints[0]?.status).toBe('pending')
      expect(
        w.messages.filter((m) => m.command === 'setBreakpoints').at(-1).arguments.source.path
      ).toBe(source)
      runtime.scriptCount = 2
      runtime.sourceMaps = true
      runtime.mapped.add(source)
      runtime.set(source, createHash('sha256').update(original).digest('hex'))
      w.send({
        type: 'event',
        event: 'breakpoint',
        body: {
          reason: 'changed',
          breakpoint: { id: 101, verified: true, line: 1 },
        },
      })
      await vi.waitFor(() => expect(session.snapshot.breakpoints[0]?.status).toBe('verified'))
      expect((await add()).attachment).toEqual({
        name: 'app.js',
        pid: 42,
        folder: dir,
        loaded_scripts: 2,
        source_maps: true,
        files: [{ path: 'lazy.ts', loaded: true, mapped: true }],
      })
      runtime.truncated = true
      runtime.mapped.clear()
      runtime.mapSources.clear()
      runtime.scripts.clear()
      expect((await add()).attachment).toEqual({
        name: 'app.js',
        pid: 42,
        folder: dir,
        loaded_scripts: 2,
        source_maps: true,
        files: [{ path: 'lazy.ts' }],
      })
      runtime.available = false
      expect((await add()).attachment).toEqual({
        name: 'app.js',
        pid: 42,
        folder: dir,
        files: [{ path: 'lazy.ts' }],
      })
    } finally {
      await core.debuggerLaunches.close()
      fake.stop()
      w.dap.close()
      await core.resources.stop()
      core.close()
      vi.restoreAllMocks()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
