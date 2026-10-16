import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { LspTools } from '../packages/node-core/src/lsp/tools.js'
import { LspClient } from '../packages/node-client/src/lsp.js'

it('dispatches typed calls through the real confinement and journals agent diagnostics notices', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/lsp-node-'))
  const root = join(dir, 'project'),
    state = join(dir, 'state')
  mkdirSync(root)
  writeFileSync(join(root, 'a.ts'), 'let a = 1')
  symlinkSync('/etc/passwd', join(root, 'escape.ts'))
  const git = join(dir, 'fake-git')
  writeFileSync(git, '#!/bin/sh\nexit 1\n')
  chmodSync(git, 0o700)
  const bin = join(state, 'lsp/typescript/node_modules/.bin')
  mkdirSync(bin, { recursive: true })
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
    const workspaces = (await rpc('workspace.list', { project_id: project.project_id })) as any[]
    const workspace_id = workspaces[0].workspace_id
    // Mark this fixture root as managed without running real Git provisioning.
    core.db
      .prepare("UPDATE workspaces SET body=json_set(body,'$.kind','managed') WHERE workspace_id=?")
      .run(workspace_id)
    const session = (await rpc('session.create', { workspace_id })) as any
    const client = new LspClient(rpc)
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
    let notices: any[] = []
    for (let i = 0; i < 100; i++) {
      notices = core.read(session.session_id, 0).filter((e) => e.type === 'session.update')
      if (notices.length) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(
      notices.some(
        (e) => e.data.update.kind === 'notice' && e.data.update.text.includes('[typescript]')
      )
    ).toBe(true)
    expect(core.read('catalog', 0).some((e) => e.type === 'lsp.diagnostics')).toBe(true)
    const abort = new AbortController()
    const pending = client.hover({ workspace_id }, 'a.ts', { line: 0, character: 0 }, abort.signal)
    abort.abort()
    await expect(pending).rejects.toThrow('cancelled')
    bridge.close()
  } finally {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
