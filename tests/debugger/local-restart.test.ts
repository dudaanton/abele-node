import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { jsAdapterInstalled } from '../../packages/node-core/src/debugger/js-install.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
// Reuse the explicitly installed, audited adapter; ordinary CI never downloads it.
// Repeat because the startup inspector evaluation race does not fail every launch.
it
  .skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !jsAdapterInstalled(stateDirectory))
  .each([0, 1, 2, 3, 4, 5, 6, 7])(
  'opt-in: native folder launch holds its first stop after detach and crash restarts (%i)',
  async () => {
    mkdirSync('.scratch/debugger-integration', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/restart-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src/journey.cjs'),
      [
        'function inspectItem(n) {',
        '  const item = { count: n, nested: { label: "sample-" + n } }',
        '  return item',
        '}',
        'function calculate(n) {',
        '  const item = inspectItem(n)',
        '  if (n === 2) throw new Error("Synthetic calculation failure")',
        '  return item.count * 2',
        '}',
        'let next = 0',
        'setInterval(() => console.log(calculate(next++)), 20)',
        '',
      ].join('\n')
    )
    const core = new NodeCore(join(dir, 'core'), {
      debuggerEnabled: true,
      debuggerProfile: (core) =>
        new JsDebugProfile(core.debugger, { stateDirectory, enabled: true }),
    })
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    const request = async (method: string, p: any) =>
      (await core.request(owner, method, p, p.operation_id ?? crypto.randomUUID())) as any
    const until = async (check: () => boolean) => {
      const end = Date.now() + 10000
      while (!check()) {
        if (Date.now() > end) throw new Error('local_debugger_timeout')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    try {
      const project = await request('project.register', {
        path: dir,
        trust: 'trusted',
        exact_root: true,
      })
      const [workspace] = await request('workspace.list', { project_id: project.project_id })
      const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
      await request('project.execution', {
        project_id: project.project_id,
        target: folder,
        enabled: true,
      })
      let result = await request('debugger.v1.start', {
        operation_id: 'start',
        folder,
        program: 'src/journey.cjs',
      })
      const sessions = new Set<string>()
      const incarnations = new Set<string>()
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = result.debug_session_id
        const snapshot = () => core.debugger.snapshot(id).snapshot
        await until(
          () =>
            snapshot().execution === 'stopped' ||
            !['active', 'configuring'].includes(snapshot().lifecycle)
        )
        expect(snapshot().lifecycle).toBe('active')
        expect(snapshot().execution).toBe('stopped')
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(snapshot().execution).toBe('stopped')
        expect(sessions.has(id)).toBe(false)
        expect(incarnations.has(snapshot().incarnation)).toBe(false)
        sessions.add(id)
        incarnations.add(snapshot().incarnation)
        const state = snapshot()
        const command = await request(
          attempt === 0 ? 'debugger.v1.detach' : 'debugger.v1.continue',
          {
            operation_id: crypto.randomUUID(),
            debug_session_id: id,
            incarnation: state.incarnation,
            expected_state_revision: state.state_revision,
            ...(attempt === 0 ? {} : { thread_id: state.selected_thread_id }),
          }
        )
        expect(command.outcome).toBe('completed')
        if (attempt !== 0) {
          await until(() => snapshot().lifecycle === 'terminated')
        }
        if (attempt < 2)
          result = await request('debugger.v1.restart', {
            operation_id: `restart-${attempt}`,
            debug_session_id: id,
          })
      }
    } finally {
      await core.debuggerLaunches.close()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  45000
)
