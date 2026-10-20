import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelError } from '@abele/channel-protocol'
import { NodeCore, type LaunchProfile } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { adapter } from '../trace/adapter.js'

it('retains added paths across node recovery and restores breakpoints by path after re-admission', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'debug-sources-recovery-')))
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'first.ts'), 'const n: number = 1\n')
  writeFileSync(join(dir, 'late.js'), 'console.log(2)\n')
  writeFileSync(
    join(dir, 'app.js.map'),
    JSON.stringify({
      sources: ['first.ts'],
      sourcesContent: ['const n: number = 1\n'],
    })
  )
  const profile = (core: NodeCore): LaunchProfile => ({
    profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
    async launch(_config, target, sources) {
      const w = wire()
      const fake = adapter(w, () => ({}), dir)
      const root = new DapSession(core.debugger, core.debugger.create(target), w.dap, sources)
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
  const open = () => {
    const core = new NodeCore(join(dir, 'state'), {
      debuggerEnabled: true,
      debuggerProfile: profile,
    })
    vi.spyOn(core.resources.git, 'text').mockRejectedValue(new ChannelError('git_failed'))
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    return {
      core,
      request: async (method: string, p: any) =>
        (await core.request(owner, method, p, p.operation_id ?? crypto.randomUUID())) as any,
    }
  }
  let current = open()
  const close = async () => {
    await current.core.debuggerLaunches.close()
    await current.core.resources.stop()
    current.core.close()
  }
  try {
    const project = await current.request('project.register', { path: dir, trust: 'trusted' })
    const [workspace] = await current.request('workspace.list', { project_id: project.project_id })
    const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
    await current.request('project.execution', {
      project_id: project.project_id,
      target: folder,
      enabled: true,
    })
    const first = await current.request('debugger.v1.start', {
      operation_id: 'start',
      folder,
      program: 'app.js',
    })
    const added = await current.request('debugger.v1.addSources', {
      operation_id: 'add',
      debug_session_id: first.debug_session_id,
      sources: ['first.ts', 'late.js'],
    })
    expect(added.sources).toEqual([
      { source_id: 's2', path: 'first.ts' },
      { source_id: 's3', path: 'late.js' },
    ])
    current.core.debugger.patchBreakpoints(
      first.debug_session_id,
      0,
      [
        { breakpoint_id: 'unbuilt', source_id: 's2', line: 1 },
        { breakpoint_id: 'kept', source_id: 's3', line: 1, enabled: false, hit_condition: '3' },
      ],
      []
    )
    await close()
    // This source no longer has proof when the node starts again.
    rmSync(join(dir, 'app.js.map'))
    current = open()
    const restarted = await current.request('debugger.v1.restart', {
      operation_id: 'restart',
      debug_session_id: first.debug_session_id,
    })
    expect(restarted.sources).toEqual([
      { source_id: 's1', path: 'app.js' },
      { source_id: 's2', path: 'late.js' },
    ])
    expect(
      current.core.debugger.snapshot(restarted.debug_session_id).snapshot.breakpoints
    ).toMatchObject([
      { breakpoint_id: 'kept', source_id: 's2', enabled: false, hit_condition: '3' },
    ])
    expect(
      current.core.debugger.snapshot(restarted.debug_session_id).snapshot.breakpoints
    ).toHaveLength(1)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
