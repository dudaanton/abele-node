import { it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProjectSchema } from '@abele/node-protocol'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { LspTools } from '../packages/node-core/src/lsp/tools.js'
import { LspClient } from '../packages/node-client/src/lsp.js'

it('preserves optional server diagnostics through the typed status client', async () => {
  const rows = [
    {
      language: 'rust',
      server: null,
      version: null,
      found: false,
      diagnostic: 'rust-analyzer component unavailable; run rustup component add rust-analyzer',
    },
  ]
  const client = new LspClient(async (method) => {
    expect(method).toBe('lsp.v1.status')
    return rows
  })
  await expect(client.status()).resolves.toEqual(rows)
})

it.each(['direct', 'symlinked'] as const)(
  'dispatches typed calls through the real confinement and publishes file diagnostics without chat notices (%s root)',
  async (kind) => {
    mkdirSync('.scratch', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/lsp-node-'))
    const realRoot = join(dir, 'project'),
      state = join(dir, 'state')
    mkdirSync(realRoot)
    const root = kind === 'symlinked' ? join(dir, 'project-alias') : realRoot
    if (kind === 'symlinked') symlinkSync(realRoot, root)
    writeFileSync(join(root, 'a.ts'), 'let a = 1')
    symlinkSync('/etc/passwd', join(root, 'escape.ts'))
    const git = join(dir, 'fake-git')
    writeFileSync(git, '#!/bin/sh\nexit 1\n')
    chmodSync(git, 0o700)
    const bin = join(state, 'lsp/typescript/node_modules/.bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(state, 'lsp/typescript/node_modules/typescript/lib'), { recursive: true })
    writeFileSync(join(state, 'lsp/typescript/node_modules/typescript/lib/tsserver.js'), '')
    const executable = join(bin, 'typescript-language-server')
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nimport(${JSON.stringify(resolve('tests/fixtures/fake-lsp.mjs'))})\n`
    )
    chmodSync(executable, 0o700)
    const core = new NodeCore(state, { git: new GitRunner(15000, 512 * 1024, git) })
    try {
      const actor = core.authority.authenticate(core.createToken('fixture').token)
      let n = 0
      const rpc = (method: string, params: unknown) =>
        Promise.resolve(core.request(actor, method, params, 'op-' + ++n))
      const project = (await rpc('project.register', { path: root, trust: 'untrusted' })) as any
      expect(project.root_path).toBe(realpathSync(realRoot))
      const workspaces = (await rpc('workspace.list', { project_id: project.project_id })) as any[]
      const workspace_id = workspaces[0].workspace_id
      // Mark this fixture root as managed without running real Git provisioning.
      core.db
        .prepare(
          "UPDATE workspaces SET body=json_set(body,'$.kind','managed') WHERE workspace_id=?"
        )
        .run(workspace_id)
      const session = (await rpc('session.create', { workspace_id })) as any
      const client = new LspClient(rpc)
      const untrusted = await client.status({ workspace_id })
      expect(untrusted.find((row) => row.language === 'typescript')).toMatchObject({
        found: true,
        reason: 'untrusted_folder',
      })
      expect(await client.open({ workspace_id }, 'a.ts')).toEqual({ servers: [] })
      expect(await client.diagnostics({ workspace_id }, 'a.ts')).toEqual([])
      await expect(
        client.definition({ workspace_id }, 'a.ts', { line: 0, character: 1 })
      ).rejects.toThrow('untrusted_folder')
      core.resources.lsp.observe(session.session_id, 'pi.tool.call', {
        name: 'write',
        input: { path: 'a.ts' },
      })
      await core.resources.lsp.afterEdit(session.session_id)
      expect((core.resources.lsp.service as any).slots.size).toBe(0)
      await rpc('project.trust', { project_id: project.project_id, trust: 'trusted' })
      const other = join(dir, 'other')
      mkdirSync(other)
      writeFileSync(join(other, 'a.ts'), '')
      const otherProject = (await rpc('project.register', {
        path: other,
        trust: 'untrusted',
      })) as any
      const [otherWorkspace] = (await rpc('workspace.list', {
        project_id: otherProject.project_id,
      })) as any[]
      expect(await client.open({ workspace_id: otherWorkspace.workspace_id }, 'a.ts')).toEqual({
        servers: [],
      })
      expect(
        (await client.status({ workspace_id })).find((row) => row.language === 'typescript')
      ).not.toHaveProperty('reason')
      const locations = await client.definition({ workspace_id }, 'a.ts', { line: 0, character: 1 })
      expect(locations.map((l) => l.path)).toEqual(['a.ts'])
      await expect(client.open({ workspace_id }, '../secret.ts')).rejects.toThrow()
      await expect(client.open({ workspace_id }, 'escape.ts')).rejects.toThrow()
      const bridge = new LspTools(core, session.session_id, actor.installation_id, () => true)
      expect(bridge.tools[0]!.name).toBe('lsp')
      // Trust-bound agent tools require a running execution, so validate their exposed schema here.
      core.resources.lsp.observe(session.session_id, 'pi.tool.call', {
        name: 'write',
        input: { path: 'a.ts' },
      })
      await core.resources.lsp.afterEdit(session.session_id)
      let diagnostics: any[] = []
      for (let i = 0; i < 100; i++) {
        diagnostics = core.read('catalog', 0).filter((e) => e.type === 'lsp.diagnostics')
        if (diagnostics.length) break
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(
        diagnostics.some((e) => e.data.diagnostics.some((d: any) => d.source === 'typescript'))
      ).toBe(true)
      expect(core.read(session.session_id, 0).filter((e) => e.type === 'session.update')).toEqual(
        []
      )
      const abort = new AbortController()
      const pending = client.hover(
        { workspace_id },
        'a.ts',
        { line: 0, character: 0 },
        abort.signal
      )
      abort.abort()
      await expect(pending).rejects.toThrow('cancelled')
      bridge.close()
      const connection = [...(core.resources.lsp.service as any).slots.values()][0].connection
      await rpc('project.trust', { project_id: project.project_id, trust: 'untrusted' })
      expect((core.resources.lsp.service as any).slots.size).toBe(0)
      connection.onNotification('textDocument/publishDiagnostics', {
        uri: pathToFileURL(join(root, 'a.ts')).href,
        diagnostics: [
          {
            message: 'late untrusted result',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      })
      expect(await client.diagnostics({ workspace_id }, 'a.ts')).toEqual([])
      const registered = core
        .read('catalog', 0)
        .filter((e) => e.type === 'project.registered')
        .at(-1)
      expect(ProjectSchema.parse(registered?.data).trust).toBe('untrusted')
    } finally {
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
