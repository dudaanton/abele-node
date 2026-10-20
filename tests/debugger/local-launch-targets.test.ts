import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import {
  JsDebugProfile,
  type NativeJsRun,
} from '../../packages/node-core/src/debugger/js-profile.js'
import { JS_DEBUG_PIN } from '../../packages/node-core/src/debugger/js-install.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
const installed =
  JS_DEBUG_PIN &&
  existsSync(
    join(stateDirectory, 'debugger/adapters/js-debug', JS_DEBUG_PIN.version, 'installation.json')
  )

// Uses only a synthetic program and an already installed, audited adapter.
it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !installed)(
  'opt-in: npm scripts bind nested NodeNext TypeScript breakpoints in ignored dist output',
  async () => {
    const dir = mkdtempSync(resolve('.scratch/npm-debug-'))
    mkdirSync(join(dir, 'src/client'), { recursive: true })
    writeFileSync(join(dir, '.gitignore'), 'dist/\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: {
          start: 'node dist/main.js --start',
          client: 'node dist/client/main.js --client',
        },
      })
    )
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          rootDir: 'src',
          outDir: 'dist',
          sourceMap: true,
          types: [],
        },
        include: ['src'],
      })
    )
    writeFileSync(join(dir, 'src/main.ts'), "import './client/main.js'\n")
    writeFileSync(
      join(dir, 'src/client/main.ts'),
      'export const input: number = 40;\nexport const answer = input + 2;\nconsole.log(answer);\n'
    )
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', dir])
    const runs: NativeJsRun[] = []
    const core = new NodeCore(join(dir, 'core'), {
      debuggerEnabled: true,
      debuggerProfile: (core) => {
        const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
        return {
          profiles: () => profile.profiles(),
          async launch(...args) {
            const run = await profile.launch(...args)
            runs.push(run)
            return run
          },
        }
      },
    })
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    const request = (method: string, params: any) =>
      core.request(
        owner,
        method,
        params,
        params.operation_id ?? crypto.randomUUID()
      ) as Promise<any>
    try {
      const project = await request('project.register', { path: dir, trust: 'trusted' })
      const [workspace] = await request('workspace.list', { project_id: project.project_id })
      const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
      await request('project.execution', {
        project_id: project.project_id,
        target: folder,
        enabled: true,
      })
      for (const npm_script of ['start', 'client']) {
        const started = await request('debugger.v1.start', {
          operation_id: npm_script,
          folder,
          program: 'package.json',
          npm_script,
          argv: ['extra argument'],
          sources: ['src/client/main.ts'],
        })
        const session = await runs.at(-1)!.program()
        const source = started.sources.find((s: any) => s.path === 'src/client/main.ts')!
        expect(source).toBeDefined()
        core.debugger.patchBreakpoints(
          session.id,
          session.snapshot.breakpoint_revision,
          [{ breakpoint_id: 'line', source_id: source.source_id, line: 2 }],
          []
        )
        await session.syncBreakpoints()
        await session.threads()
        const epoch = session.snapshot.stop_epoch
        await session.continue(session.snapshot.selected_thread_id!)
        const deadline = Date.now() + 10000
        while (session.snapshot.stop_epoch <= epoch || session.snapshot.execution !== 'stopped') {
          if (Date.now() > deadline) throw new Error('typescript_breakpoint_timeout')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        await session.threads()
        const stack = await session.stack(session.snapshot.selected_thread_id!, 0, 1)
        expect(stack.items[0]).toMatchObject({ source_id: source.source_id, line: 2 })
        await runs.at(-1)!.terminate()
      }
    } finally {
      await Promise.all(runs.map((run) => run.close()))
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
