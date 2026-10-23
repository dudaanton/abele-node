import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  realpathSync,
  existsSync,
  readFileSync,
  renameSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProjectSchema } from '@abele/node-protocol'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { LspTools } from '../packages/node-core/src/lsp/tools.js'
import { LspClient } from '../packages/node-client/src/lsp.js'

it.each(['status', 'open'] as const)(
  'analyzes a readable external linked worktree without edit approval (%s first)',
  async (first) => {
    const dir = mkdtempSync(resolve('.scratch/lsp-readable-'))
    const repo = join(dir, 'repo'),
      linked = join(dir, 'linked'),
      state = join(dir, 'state')
    mkdirSync(repo)
    const gitPath = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
      ? '/Library/Developer/CommandLineTools/usr/bin/git'
      : '/usr/bin/git'
    const git = (...args: string[]) => {
      const result = spawnSync(gitPath, args, { cwd: repo, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    git('init', '-b', 'trunk')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(repo, 'a.ts'), 'let a = 1')
    git('add', '.')
    git('commit', '-m', 'fixture')
    git('worktree', 'add', '-b', 'linked', linked)
    symlinkSync(join(repo, 'a.ts'), join(linked, 'escape.ts'))
    const bin = join(state, 'lsp/typescript/node_modules/.bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(state, 'lsp/typescript/node_modules/typescript/lib'), { recursive: true })
    writeFileSync(join(state, 'lsp/typescript/node_modules/typescript/lib/tsserver.js'), '')
    const executable = join(bin, 'typescript-language-server')
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nprocess.argv[3] = ${JSON.stringify(join(dir, 'server.log'))}\nimport(${JSON.stringify(resolve('tests/fixtures/fake-lsp.mjs'))})\n`
    )
    chmodSync(executable, 0o700)
    const core = new NodeCore(state, { git: new GitRunner(15000, 512 * 1024, gitPath) })
    try {
      const actor = core.authority.authenticate(core.createToken('fixture').token)
      let n = 0
      const rpc = async (method: string, params: unknown) =>
        (await core.request(actor, method, params, 'op-' + ++n)) as any
      const project = await rpc('project.register', { path: repo, trust: 'untrusted' })
      await rpc('project.repository_settings', {
        project_id: project.project_id,
        external_read: true,
      })
      const { entries } = await rpc('repository.v1.worktrees', { project_id: project.project_id })
      const target = entries.find((e: any) => e.kind === 'external')
      expect(target.kind).toBe('external')
      const ref = { worktree_id: target.worktree_id }
      const client = new LspClient(rpc)
      expect(
        core.db
          .prepare('SELECT * FROM repository_edit_permissions WHERE worktree_id=?')
          .get(target.worktree_id)
      ).toBeUndefined()
      await (first === 'status' ? client.status(ref) : client.open(ref, 'a.ts'))
      expect((await client.status(ref)).find((r) => r.language === 'typescript')).toMatchObject({
        found: true,
        reason: 'untrusted_folder',
      })
      expect(await client.open(ref, 'a.ts')).toEqual({ servers: [] })
      await rpc('project.trust', { project_id: project.project_id, trust: 'trusted' })
      expect(
        (await client.status(ref)).find((r) => r.language === 'typescript')
      ).not.toHaveProperty('reason')
      expect((await client.open(ref, 'a.ts')).servers).toContain('typescript')
      expect(JSON.parse(readFileSync(join(dir, 'server.log.initialize'), 'utf8')).rootUri).toBe(
        pathToFileURL(linked).href
      )
      expect(
        (await client.definition(ref, 'a.ts', { line: 0, character: 1 })).map((l) => l.path)
      ).toEqual(['a.ts'])
      const executionTarget = { kind: 'worktree', ...ref }
      await rpc('project.execution', {
        project_id: project.project_id,
        target: executionTarget,
        enabled: true,
      })
      const session = await rpc('session.create', { provider: 'fake', target: executionTarget })
      expect(
        core.db
          .prepare('SELECT * FROM repository_edit_permissions WHERE worktree_id=?')
          .get(target.worktree_id)
      ).toBeUndefined()
      expect(core.resources.lsp.sessionRoot(session.session_id)).toBe(linked)
      const bridge = new LspTools(core, session.session_id, actor.installation_id, () => true)
      try {
        const result = await bridge.call('lsp', {
          operation: 'definition',
          path: 'a.ts',
          position: { line: 0, character: 1 },
        })
        expect(result.locations.map((l: any) => l.path)).toEqual(['a.ts'])
        expect(bridge.publish({}, result)).toBe(result)
      } finally {
        bridge.close()
      }
      writeFileSync(join(linked, 'a.ts'), 'let a = 2')
      core.resources.lsp.observe(session.session_id, 'pi.tool.call', {
        name: 'write',
        input: { path: 'a.ts' },
      })
      await core.resources.lsp.afterEdit(session.session_id)
      await expect
        .poll(() => readFileSync(join(dir, 'server.log'), 'utf8'), { timeout: 10000 })
        .toContain('textDocument/didChange')
      await expect
        .poll(() => client.diagnostics(ref, 'a.ts'))
        .toEqual([expect.objectContaining({ source: 'typescript' })])
      await expect(client.open(ref, '../repo/a.ts')).rejects.toThrow()
      await expect(client.open(ref, 'escape.ts')).rejects.toThrow('unsafe_path')
      expect(() =>
        core.resources.files.writeTarget(target.worktree_id, 'a.ts', false, true)
      ).toThrow('unauthorized')
      await expect(
        rpc('repository.v1.write', {
          ...ref,
          path: 'a.ts',
          expected_content_id: null,
          text: 'forbidden',
        })
      ).rejects.toThrow('unauthorized')
      // Checkpoint previews can read this root; restoring files still needs edit approval.
      rmSync(join(linked, 'escape.ts'))
      const nativeDir = join(state, 'pi-sessions', session.session_id)
      mkdirSync(nativeDir, { recursive: true })
      const native = join(nativeDir, 'fixture.jsonl')
      writeFileSync(native, JSON.stringify({ type: 'session', id: 'fixture', cwd: linked }) + '\n')
      core.db.prepare('UPDATE sessions SET body=? WHERE session_id=?').run(
        JSON.stringify({
          ...core.session(session.session_id),
          provider: 'pi',
          native_session_file: native,
        }),
        session.session_id
      )
      await core.chatCheckpoints.capture(session.session_id, 'fixture-input')
      const [checkpoint] = await rpc('chat.checkpoints', { session_id: session.session_id })
      expect(checkpoint).toBeDefined()
      writeFileSync(join(linked, 'a.ts'), 'let a = 3')
      const checkpointRef = {
        session_id: session.session_id,
        checkpoint_id: checkpoint.checkpoint_id,
      }
      const preview = await rpc('chat.preview', checkpointRef)
      await expect(
        rpc('chat.restore', {
          ...checkpointRef,
          action: 'rewind',
          restore_files: { preview_id: preview.preview_id, changes: preview.changes },
        })
      ).rejects.toThrow('unauthorized')
      expect(readFileSync(join(linked, 'a.ts'), 'utf8')).toBe('let a = 3')
      await rpc('repository.v1.editing', { ...ref, enabled: true })
      await rpc('chat.restore', {
        ...checkpointRef,
        action: 'rewind',
        restore_files: { preview_id: preview.preview_id, changes: preview.changes },
      })
      expect(readFileSync(join(linked, 'a.ts'), 'utf8')).toBe('let a = 2')
      await rpc('repository.v1.editing', { ...ref, enabled: false })
      await rpc('project.trust', { project_id: project.project_id, trust: 'untrusted' })
      expect(await client.diagnostics(ref, 'a.ts')).toEqual([])
      expect((await client.status(ref)).find((r) => r.language === 'typescript')).toHaveProperty(
        'reason',
        'untrusted_folder'
      )
      await rpc('project.repository_settings', {
        project_id: project.project_id,
        external_read: false,
      })
      await expect(client.status(ref)).rejects.toThrow('unauthorized')
      await expect(client.open(ref, 'a.ts')).rejects.toThrow('unauthorized')
      await rpc('project.repository_settings', {
        project_id: project.project_id,
        external_read: true,
      })
      const gitFile = readFileSync(join(linked, '.git'), 'utf8')
      renameSync(join(linked, '.git'), join(linked, '.git.previous'))
      writeFileSync(join(linked, '.git'), gitFile)
      await expect(client.status(ref)).rejects.toThrow('stale_resource')
      await expect(client.open(ref, 'a.ts')).rejects.toThrow('stale_resource')
    } finally {
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

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
