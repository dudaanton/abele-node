import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { LspClient } from '../packages/node-client/src/lsp.js'

async function setup(worktrees = 1, waitForInitialize = false) {
  const dir = mkdtempSync(resolve('.scratch/lsp-limits-'))
  const repo = join(dir, 'main'),
    state = join(dir, 'state')
  mkdirSync(repo)
  const gitPath = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
    ? '/Library/Developer/CommandLineTools/usr/bin/git'
    : '/usr/bin/git'
  const git = (...args: string[]) => execFileSync(gitPath, args, { cwd: repo, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  for (let i = 0; i < 65; i++) writeFileSync(join(repo, `file${i}.ts`), 'let value = 1')
  git('add', '.')
  git('commit', '-m', 'fixture')
  for (let i = 0; i < worktrees; i++)
    git('worktree', 'add', '-b', `linked${i}`, join(dir, `linked${i}`))
  const bin = join(state, 'lsp/typescript/node_modules/.bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(state, 'lsp/typescript/node_modules/typescript/lib'), { recursive: true })
  writeFileSync(join(state, 'lsp/typescript/node_modules/typescript/lib/tsserver.js'), '')
  const server = join(bin, 'typescript-language-server')
  writeFileSync(
    server,
    `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('fixture'); else { process.argv[2] = ${JSON.stringify(waitForInitialize ? 'initialize-wait' : 'typescript')}; import(${JSON.stringify(resolve('tests/fixtures/fake-lsp.mjs'))}) }\n`
  )
  chmodSync(server, 0o700)
  const core = new NodeCore(state, { git: new GitRunner(15000, 512 * 1024, gitPath) })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const rpc = async (method: string, params: unknown): Promise<any> =>
    await core.request(actor, method, params, crypto.randomUUID())
  const project = await rpc('project.register', { path: repo, trust: 'trusted' })
  await rpc('project.repository_settings', { project_id: project.project_id, external_read: true })
  const { entries } = await rpc('repository.v1.worktrees', { project_id: project.project_id })
  const targets = entries.filter((e: any) => e.kind === 'external')
  const client = new LspClient(rpc)
  const status = async (worktree_id: string) =>
    (await client.status({ worktree_id })).find((s) => s.language === 'typescript')
  const stop = async () => {
    vi.useRealTimers()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, core, rpc, targets, status, stop }
}

it('reports an oversized nested document through RPC and scoped status, then recovers', async () => {
  const f = await setup(2)
  try {
    const worktree_id = f.targets[0].worktree_id
    const path = 'packages/a/src/x.test.ts'
    mkdirSync(join(f.dir, 'linked0/packages/a/src'), { recursive: true })
    writeFileSync(join(f.dir, 'linked0', path), ' '.repeat(512 * 1024 + 1))
    await expect(f.rpc('lsp.v1.open', { worktree_id, path })).rejects.toMatchObject({
      code: 'output_limit',
    })
    expect(await f.status(worktree_id)).toMatchObject({
      found: true,
      diagnostic: expect.stringContaining('output_limit'),
    })
    expect(f.core.read('catalog', 0)).toContainEqual(
      expect.objectContaining({
        type: 'lsp.status',
        data: expect.objectContaining({
          worktree_id,
          message: expect.stringContaining('output_limit'),
        }),
      })
    )
    const noticeCount = () =>
      f.core
        .read('catalog', 0)
        .filter(
          (e) =>
            e.type === 'lsp.status' &&
            typeof e.data === 'object' &&
            e.data !== null &&
            'worktree_id' in e.data &&
            e.data.worktree_id === worktree_id
        ).length
    const before = noticeCount()
    await expect(f.rpc('lsp.v1.open', { worktree_id, path })).rejects.toMatchObject({
      code: 'output_limit',
    })
    expect(noticeCount()).toBe(before)
    expect(await f.status(f.targets[1].worktree_id)).not.toHaveProperty('diagnostic')
    expect(
      (await f.rpc('lsp.v1.status', {})).find((s: any) => s.language === 'typescript')
    ).not.toHaveProperty('diagnostic')
    writeFileSync(join(f.dir, 'linked0', path), 'let value = 1')
    await expect(f.rpc('lsp.v1.open', { worktree_id, path })).resolves.toEqual({
      servers: ['typescript'],
    })
    expect(await f.status(worktree_id)).not.toHaveProperty('diagnostic')
  } finally {
    await f.stop()
  }
})

it('bounds open buffers, not repository file count, and reports the 65th document failure', async () => {
  const f = await setup()
  try {
    const worktree_id = f.targets[0].worktree_id
    for (let i = 0; i < 64; i++) await f.rpc('lsp.v1.open', { worktree_id, path: `file${i}.ts` })
    await expect(f.rpc('lsp.v1.open', { worktree_id, path: 'file64.ts' })).rejects.toMatchObject({
      details: { reason: 'lsp_document_limit' },
    })
    expect(await f.status(worktree_id)).toMatchObject({
      diagnostic: expect.stringContaining('lsp_document_limit'),
    })
    await f.rpc('lsp.v1.close', { worktree_id, path: 'file0.ts' })
    await expect(f.rpc('lsp.v1.open', { worktree_id, path: 'file64.ts' })).resolves.toEqual({
      servers: ['typescript'],
    })
    expect(await f.status(worktree_id)).not.toHaveProperty('diagnostic')
  } finally {
    await f.stop()
  }
})

it('reports the process limit across roots and recovers after a root is released', async () => {
  const f = await setup(17)
  try {
    for (const target of f.targets.slice(0, 16))
      await f.rpc('lsp.v1.open', { worktree_id: target.worktree_id, path: 'file0.ts' })
    const worktree_id = f.targets[16].worktree_id
    await expect(f.rpc('lsp.v1.open', { worktree_id, path: 'file0.ts' })).rejects.toMatchObject({
      details: { reason: 'lsp_process_limit' },
    })
    expect(await f.status(worktree_id)).toMatchObject({
      diagnostic: expect.stringContaining('lsp_process_limit'),
    })
    await f.core.resources.lsp.releaseRoot(
      f.core.resources.repository.executionIdentity(f.targets[0].worktree_id).path
    )
    await expect(f.rpc('lsp.v1.open', { worktree_id, path: 'file0.ts' })).resolves.toEqual({
      servers: ['typescript'],
    })
    expect(await f.status(worktree_id)).not.toHaveProperty('diagnostic')
  } finally {
    await f.stop()
  }
})

it('reports initialization timeout instead of treating a found binary as healthy', async () => {
  const f = await setup(1, true)
  try {
    const worktree_id = f.targets[0].worktree_id
    const { LspConnection } = await import('../packages/node-core/src/lsp/connection.js')
    const request = vi.spyOn(LspConnection.prototype, 'request')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = expect(
      f.rpc('lsp.v1.open', { worktree_id, path: 'file0.ts' })
    ).rejects.toMatchObject({ code: 'lsp_timeout' })
    await vi.advanceTimersByTimeAsync(0)
    expect(request.mock.calls.some(([method]) => method === 'initialize')).toBe(true)
    await vi.advanceTimersByTimeAsync(15001)
    await failed
    vi.useRealTimers()
    expect(await f.status(worktree_id)).toMatchObject({
      found: true,
      diagnostic: expect.stringContaining('lsp_timeout'),
    })
  } finally {
    vi.restoreAllMocks()
    await f.stop()
  }
})

it('keeps repeated crashes visible to RPC callers and scoped status despite extra failure notices', async () => {
  const f = await setup()
  try {
    const worktree_id = f.targets[0].worktree_id
    const params = { worktree_id, path: 'file0.ts' }
    await f.rpc('lsp.v1.open', params)
    const slot = [...(f.core.resources.lsp.service as any).slots.values()][0]
    const hasNotice = (text: string) =>
      f.core.read('catalog', 0).some((event) => {
        const data = event.data
        return (
          event.type === 'lsp.status' &&
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof data.message === 'string' &&
          data.message.includes(text)
        )
      })
    slot.connection.notify('crash', {})
    await expect.poll(() => hasNotice('restarting once')).toBe(true)
    await expect(f.rpc('lsp.v1.open', params)).resolves.toEqual({ servers: ['typescript'] })
    slot.connection.notify('crash', {})
    await expect.poll(() => hasNotice('stopped after repeated crash')).toBe(true)
    await expect(f.rpc('lsp.v1.diagnostics', params)).rejects.toMatchObject({
      code: 'lsp_unavailable',
      details: { reason: 'lsp_repeated_crash' },
    })
    expect(await f.status(worktree_id)).toMatchObject({
      found: true,
      diagnostic: expect.stringContaining('exit 1'),
    })
    await expect(f.rpc('lsp.v1.diagnostics', params)).rejects.toMatchObject({
      code: 'lsp_unavailable',
      details: { reason: 'lsp_repeated_crash' },
    })
    await expect(f.rpc('lsp.v1.open', params)).resolves.toEqual({ servers: ['typescript'] })
    expect(await f.status(worktree_id)).not.toHaveProperty('diagnostic')
  } finally {
    await f.stop()
  }
})
