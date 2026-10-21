import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import {
  discoverLaunchTargets,
  resolveNpmScript,
} from '../../packages/node-core/src/debugger/launch-targets.js'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { ChannelError } from '@abele/channel-protocol'
import { vi } from 'vitest'
import type { LaunchProfile } from '../../packages/node-core/src/debugger/launch.js'

it('discovers ignored nested output maps and resolves script arguments without npm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launch-targets-'))
  try {
    await mkdir(join(root, 'src/client'), { recursive: true })
    await mkdir(join(root, 'dist/client'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'dist/\n')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: {
          start: 'node dist/main.js',
          client: 'node "dist/client/main.js" --name "test client"',
          build: 'tsc',
          unsafe: 'node dist/main.js && echo done',
          multiline: 'node dist/main.js\necho done',
          comment: 'node dist/main.js # ignored by shell',
        },
      })
    )
    await writeFile(join(root, 'src/main.ts'), "import './client/main.js'\n")
    await writeFile(join(root, 'src/client/main.ts'), 'export const value: number = 1\n')
    await writeFile(
      join(root, 'tsconfig.json'),
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
    execFileSync(process.execPath, [
      join(process.cwd(), 'node_modules/typescript/bin/tsc'),
      '-p',
      root,
    ])
    const { targets } = await discoverLaunchTargets(root)
    expect(targets).toContainEqual({ program: 'dist/main.js', source: 'src/main.ts' })
    expect(targets).toContainEqual({ program: 'dist/client/main.js', source: 'src/client/main.ts' })
    expect(targets).toContainEqual({ program: 'package.json', npm_script: 'client' })
    expect(await resolveNpmScript(root, 'package.json', 'client', ['extra value'])).toEqual({
      program: 'dist/client/main.js',
      argv: ['--name', 'test client', 'extra value'],
    })
    await expect(resolveNpmScript(root, 'package.json', 'unsafe', [])).rejects.toThrow(
      'debugger_npm_script_unsupported'
    )
    for (const script of ['multiline', 'comment'])
      await expect(resolveNpmScript(root, 'package.json', script, [])).rejects.toThrow(
        'debugger_npm_script_unsupported'
      )

    const launch = vi.fn<LaunchProfile['launch']>(async () => {
      throw new Error('fixture_launch')
    })
    const core = new NodeCore(join(root, 'state'), {
      debuggerEnabled: true,
      debuggerProfile: () => ({
        profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
        launch,
      }),
    })
    vi.spyOn(core.resources.git, 'text').mockRejectedValue(new ChannelError('git_failed'))
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    const request = (method: string, params: any) =>
      core.request(
        owner,
        method,
        params,
        params.operation_id ?? crypto.randomUUID()
      ) as Promise<any>
    try {
      const project = await request('project.register', { path: root, trust: 'trusted' })
      const [workspace] = await request('workspace.list', { project_id: project.project_id })
      const folder = { kind: 'workspace', workspace_id: workspace.workspace_id }
      await expect(request('debugger.v1.launchTargets', { folder })).rejects.toThrow('unauthorized')
      await request('project.execution', {
        project_id: project.project_id,
        target: folder,
        enabled: true,
      })
      expect(core.debuggerControl.methods()).toContain('debugger.v1.launchTargets')
      expect((await request('debugger.v1.launchTargets', { folder })).targets).toEqual(targets)
      await expect(
        request('debugger.v1.start', {
          operation_id: 'missing-program',
          folder,
          program: 'dist/missing.js',
        })
      ).rejects.toMatchObject({ code: 'debugger_program_not_found' })
      expect(launch).not.toHaveBeenCalled()
      await expect(
        request('debugger.v1.start', {
          operation_id: 'script',
          folder,
          program: 'package.json',
          npm_script: 'client',
          argv: ['extra value'],
          sources: ['src/client/main.ts'],
        })
      ).rejects.toThrow('fixture_launch')
      // Launches use the folder's canonical path (macOS temp folders sit behind a symlink).
      const real = await realpath(root)
      expect(launch.mock.calls[0]?.[0]).toMatchObject({
        cwd: real,
        program: join(real, 'dist/client/main.js'),
        argv: ['--name', 'test client', 'extra value'],
      })
      expect(launch.mock.calls[0]?.[1]).toMatchObject({ process_ownership: 'owned' })
      expect([...launch.mock.calls[0]![2].values()]).toContain(join(real, 'src/client/main.ts'))
    } finally {
      core.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
