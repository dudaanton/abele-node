import { mkdtemp, mkdir, writeFile, utimes, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DebuggerStartSchema } from '@abele/node-protocol'
import { validateJsLaunch } from '../../packages/node-core/src/debugger/js-profile.js'
import {
  admitSources,
  launchWorkingDirectory,
  unbuilt,
} from '../../packages/node-core/src/debugger/launch.js'
import { emptySourceEvidence } from '../../packages/node-core/src/debugger/loaded-sources.js'
import ts from 'typescript'

it('proves a standalone transpile build with a relocated map and no tsconfig', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'standalone-proof-')))
  try {
    await mkdir(join(dir, 'src'))
    await mkdir(join(dir, 'dist'))
    const source = join(dir, 'src/total.ts'),
      original = 'const value: number = 1\nconsole.log(value)\n'
    await writeFile(source, original)
    const output = ts.transpileModule(original, {
      fileName: 'total.ts',
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        sourceMap: true,
        sourceRoot: '',
      },
    })
    await writeFile(
      join(dir, 'dist/total.js'),
      output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '') +
        '\n//# sourceMappingURL=total.js.map\n'
    )
    await writeFile(
      join(dir, 'dist/total.js.map'),
      JSON.stringify({ ...JSON.parse(output.sourceMapText!), sources: ['../src/total.ts'] })
    )
    expect(await unbuilt(dir, [source])).toEqual(new Set())
    const future = new Date(Date.now() + 60000)
    await utimes(source, future, future)
    expect(await unbuilt(dir, [source])).toEqual(new Set())
    await writeFile(source, original.replace('= 1', '= 2'))
    expect(await unbuilt(dir, [source])).toEqual(new Set([source]))
    await writeFile(source, original)
    await writeFile(join(dir, 'dist/total.js'), output.outputText.replace('= 1', '= 3'))
    expect(await unbuilt(dir, [source])).toEqual(new Set([source]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('verifies ordinary compiler maps by content and rejects edits even with preserved timestamps', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'compiler-proof-')))
  try {
    const source = join(dir, 'app.ts'),
      map = join(dir, 'app.js.map')
    const original = 'export const value: number = 1\n'
    await writeFile(source, original)
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', sourceMap: true, types: [] },
        files: ['app.ts'],
      })
    )
    const output = ts.transpileModule(original, {
      fileName: source,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
      },
    })
    await writeFile(join(dir, 'app.js'), output.outputText)
    await writeFile(map, output.sourceMapText!)
    await utimes(map, 1, 1)
    expect(await unbuilt(dir, [source])).toEqual(new Set())
    await writeFile(source, original.replace('= 1', '= 2'))
    await utimes(source, 1, 1)
    expect(await unbuilt(dir, [source])).toEqual(new Set([source]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('returns the actual stale-build reason before asking whether code is loaded', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stale-build-')))
  try {
    const path = join(dir, 'app.ts')
    await writeFile(path, 'const n = 2')
    const runtime = emptySourceEvidence()
    runtime.stale.add(path)
    expect(
      await admitSources(dir, new Map(), ['app.ts'], undefined, undefined, new Map(), {
        runtime,
        candidates: new Map(),
      })
    ).toEqual({
      sources: [],
      refused: [
        {
          path: 'app.ts',
          code: 'debugger_build_changed',
          message:
            'The build on disk differs from the running program. Restart the program to use this build.',
        },
      ],
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('accepts the paired plugin launch recipe', () => {
  expect(
    DebuggerStartSchema.parse({
      operation_id: 'launch',
      conversation_id: 'chat',
      program: 'src/index.ts',
      runtime_argv: ['--import=tsx'],
      cwd: '.',
      env: { DEBUG: '1' },
    })
  ).toMatchObject({ runtime_argv: ['--import=tsx'], cwd: '.', env: { DEBUG: '1' } })
})
it('chooses the nearest package cwd and confines explicit cwd to the folder', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'launch-cwd-')))
  try {
    await mkdir(join(dir, 'packages/service/src'), { recursive: true })
    await writeFile(join(dir, 'packages/service/package.json'), '{}')
    const program = join(dir, 'packages/service/src/index.ts')
    expect(await launchWorkingDirectory(dir, program)).toBe(join(dir, 'packages/service'))
    expect(await launchWorkingDirectory(dir, program, '.')).toBe(dir)
    await expect(launchWorkingDirectory(dir, program, '..')).rejects.toThrow('debugger_path_escape')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('uses map content instead of checkout times and never trusts a fresh map without content', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'map-identity-')))
  try {
    const source = join(dir, 'app.ts'),
      map = join(dir, 'app.js.map')
    await writeFile(source, 'const n = 1\n')
    await writeFile(map, JSON.stringify({ sources: ['app.ts'], sourcesContent: ['const n = 1\n'] }))
    await utimes(map, 1, 1)
    expect(await unbuilt(dir, [source])).toEqual(new Set())
    await writeFile(map, JSON.stringify({ sources: ['app.ts'] }))
    expect(await unbuilt(dir, [source])).toEqual(new Set([source]))
    await writeFile(map, JSON.stringify({ sources: ['app.ts'], sourcesContent: ['const n = 2\n'] }))
    expect(await unbuilt(dir, [source])).toEqual(new Set([source]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it.each([
  ['--import=tsx'],
  ['--import', 'tsx'],
  ['--loader', './loader.mjs'],
  ['--require', './setup.cjs'],
  ['--conditions=development', '--enable-source-maps'],
])('allows bounded literal loader arguments %j', async (...runtime_argv) => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-args-'))
  try {
    const program = join(dir, 'app.js')
    await writeFile(program, '')
    expect(
      (
        await validateJsLaunch({
          cwd: dir,
          executable: process.execPath,
          program,
          argv: [],
          env: {},
          runtime_argv,
        })
      ).runtime_argv
    ).toEqual(runtime_argv)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it.each([
  ['--inspect=0.0.0.0:9229'],
  ['--eval', '1'],
  ['--import'],
  ['--require', '--inspect'],
  ['--', 'other.js'],
])('refuses runtime options that replace the entry or inspector %j', async (...runtime_argv) => {
  await expect(
    validateJsLaunch({
      cwd: '/',
      executable: process.execPath,
      program: '/app.js',
      argv: [],
      env: {},
      runtime_argv,
    })
  ).rejects.toThrow('invalid_debugger_configuration')
})
