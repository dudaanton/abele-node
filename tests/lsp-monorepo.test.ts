import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { monorepo } from './fixtures/lsp-monorepo.js'
import { LspConnection } from '../packages/node-core/src/lsp/connection.js'

// Real optional servers are supplied explicitly; this test never installs packages or launches agents.
it.runIf(!!process.env.ABELE_TEST_LSP_DEPS).each(['npm', 'pnpm'] as const)(
  'analyzes a nested test in an external linked Turborepo (%s layout)',
  async (layout) => {
    const dir = mkdtempSync(resolve('.scratch/lsp-monorepo-'))
    const requests = vi.spyOn(LspConnection.prototype, 'request')
    let core: NodeCore | undefined
    try {
      const f = monorepo(dir, layout, resolve(process.env.ABELE_TEST_LSP_DEPS!))
      core = new NodeCore(f.state, { git: new GitRunner(15000, 512 * 1024, f.gitPath) })
      const actor = core.authority.authenticate(core.createToken('fixture').token)
      const rpc = async (method: string, params: unknown): Promise<any> =>
        await core!.request(actor, method, params, crypto.randomUUID())
      const project = await rpc('project.register', { path: f.repo, trust: 'trusted' })
      await rpc('project.repository_settings', {
        project_id: project.project_id,
        external_read: true,
      })
      const { entries } = await rpc('repository.v1.worktrees', { project_id: project.project_id })
      const ref = { worktree_id: entries.find((e: any) => e.kind === 'external').worktree_id }
      expect(
        (await rpc('lsp.v1.status', ref)).find((s: any) => s.language === 'eslint')
      ).toMatchObject({ found: true, project_eslint: 'found' })
      expect(await rpc('lsp.v1.open', { ...ref, path: f.path })).toEqual({
        servers: ['typescript', 'eslint'],
      })
      expect(
        (await rpc('lsp.v1.hover', { ...ref, path: f.path, position: { line: 3, character: 2 } }))
          .text
      ).toMatch(/greet\(name: string\): string/)
      expect(
        (
          await rpc('lsp.v1.definition', {
            ...ref,
            path: f.path,
            position: { line: 3, character: 2 },
          })
        ).locations
      ).toContainEqual(expect.objectContaining({ path: 'packages/b/src/index.ts' }))
      await expect
        .poll(async () => (await rpc('lsp.v1.diagnostics', { ...ref, path: f.path })).diagnostics, {
          timeout: 10000,
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source: 'typescript', code: 2322 }),
            expect.objectContaining({ source: 'typescript', code: 7006 }),
            expect.objectContaining({ source: 'eslint', code: 'no-unused-vars' }),
          ])
        )
      const slots = [...(core.resources.lsp.service as any).slots.values()]
      expect(slots).toHaveLength(2)
      for (const slot of slots) {
        expect(slot.root).toBe(f.linked)
        expect(slot.docs.size).toBe(1)
        expect(readFileSync(join(f.state, slot.language + '.cwd'), 'utf8')).toBe(f.linked)
      }
      const initialize = requests.mock.calls.filter(([method]) => method === 'initialize')
      expect(initialize).toHaveLength(2)
      for (const [, params] of initialize)
        expect(params).toMatchObject({
          rootUri: pathToFileURL(f.linked).href,
          workspaceFolders: [{ uri: pathToFileURL(f.linked).href, name: 'workspace' }],
        })
      expect(slots.find((s) => s.language === 'typescript').tsserver).toBe(
        join(f.linked, 'node_modules/typescript/lib/tsserver.js')
      )
    } finally {
      requests.mockRestore()
      await core?.resources.stop()
      core?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
