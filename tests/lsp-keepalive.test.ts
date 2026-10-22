import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LspService } from '../packages/node-core/src/lsp/service.js'
import { NodeLsp } from '../packages/node-core/src/lsp/node.js'
import type { AuthorityContext } from '@abele/channel-protocol'
import type { ResourceServices } from '../packages/node-core/src/resources.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function setup(idleMs: number | undefined = 100) {
  const root = mkdtempSync(join(tmpdir(), 'lsp-keepalive-'))
  const log = join(root, 'frames')
  for (const file of ['a.ts', 'b.ts']) writeFileSync(join(root, file), '')
  mkdirSync(join(root, 'node_modules/eslint'), { recursive: true })
  writeFileSync(join(root, 'node_modules/eslint/package.json'), '{}')
  const service = new LspService(root, {
    idleMs,
    trusted: () => true,
    check: (base, path) => join(base, path),
    command: (language) =>
      ['typescript', 'eslint'].includes(language)
        ? {
            command: process.execPath,
            args: [resolve('tests/fixtures/fake-lsp.mjs'), language, log],
          }
        : null,
  })
  cleanup.push(async () => {
    await service.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    service,
    starts: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line === 'initialize').length,
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
it('starts each language once across files in one project', async () => {
  const { root, service, starts } = setup()
  await service.open(root, 'a.ts')
  await service.open(root, 'b.ts')
  expect(starts()).toBe(2)
})
it('keeps open documents and diagnostics past idle, then stops and restarts lazily', async () => {
  const { root, service, starts } = setup()
  await service.open(root, 'a.ts')
  await sleep(50)
  const diagnostics = await service.query(root, 'a.ts', 'diagnostics')
  expect(diagnostics.diagnostics).toHaveLength(2)
  await sleep(250)
  expect((service as any).slots.size).toBe(2)
  expect(await service.query(root, 'a.ts', 'diagnostics')).toEqual(diagnostics)
  service.closeDocument(root, 'a.ts')
  await sleep(250)
  expect((service as any).slots.size).toBe(0)
  expect(starts()).toBe(2)
  await service.query(root, 'b.ts', 'hover')
  expect(starts()).toBe(4)
})
it('keeps a shared document until the last client closes it', async () => {
  const { root, service } = setup()
  await service.open(root, 'a.ts', undefined, undefined, undefined, 'client-a')
  await service.open(root, 'a.ts', undefined, undefined, undefined, 'client-b')
  service.closeDocument(root, 'a.ts', 'client-a')
  await sleep(250)
  expect((service as any).slots.size).toBe(2)
  expect([...(service as any).slots.values()].every((slot: any) => slot.docs.has('a.ts'))).toBe(
    true
  )
  service.closeDocument(root, 'a.ts', 'client-b')
  await sleep(250)
  expect((service as any).slots.size).toBe(0)
})

it('waits thirty minutes after the last close by default', async () => {
  const { root, service } = setup()
  // Omit the override for this service, keeping the production default under test.
  delete (service as any).options.idleMs
  await service.open(root, 'a.ts')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    service.closeDocument(root, 'a.ts')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1)
    expect((service as any).slots.size).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect((service as any).slots.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('starts a full idle interval after an in-flight request finishes', async () => {
  const { root, service } = setup()
  await service.open(root, 'a.ts')
  const slot = [...(service as any).slots.values()].find((s: any) => s.language === 'typescript')
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const request = vi.spyOn(slot.connection, 'request').mockImplementationOnce(async () => {
    entered()
    await gate
    return null
  })
  let pending: Promise<unknown> | undefined
  try {
    pending = service.query(root, 'a.ts', 'hover')
    await started
    service.closeDocument(root, 'a.ts')
    await sleep(250)
    expect((service as any).slots.size).toBe(2)
    release()
    await pending
    await sleep(30)
    expect((service as any).slots.size).toBe(2)
    await sleep(220)
    expect((service as any).slots.size).toBe(0)
  } finally {
    release()
    await pending
    request.mockRestore()
  }
})

it('does not acquire an extra owner during refresh or repeated opens', async () => {
  const { root, service } = setup()
  await service.open(root, 'a.ts', undefined, undefined, undefined, 'client-a')
  await service.open(root, 'a.ts', undefined, undefined, undefined, 'client-a')
  await service.refresh(root)
  service.closeDocument(root, 'a.ts', 'client-a')
  await sleep(250)
  expect((service as any).slots.size).toBe(0)
})

it('lets automatic analysis expire without a visible document', async () => {
  const { root, service } = setup()
  await service.open(root, 'a.ts', undefined, undefined, undefined, null)
  await sleep(250)
  expect((service as any).slots.size).toBe(0)
})

it('passes authenticated client identity to open, close and implicit queries', async () => {
  const lsp = new NodeLsp({
    core: { stateDir: '', authority: { check: () => {} } },
  } as unknown as ResourceServices)
  vi.spyOn(lsp, 'root').mockReturnValue('/project')
  const open = vi.spyOn(lsp.service, 'open').mockResolvedValue({ servers: [] })
  const close = vi.spyOn(lsp.service, 'closeDocument').mockReturnValue({ closed: true })
  const query = vi.spyOn(lsp.service, 'query').mockResolvedValue({ diagnostics: [] })
  try {
    for (const installation_id of ['client-a', 'client-b']) {
      const actor = { installation_id } as AuthorityContext
      const params = { workspace_id: 'project', path: 'a.ts' }
      await lsp.request(actor, 'lsp.v1.open', params)
      expect(open.mock.lastCall?.[5]).toBe(installation_id)
      await lsp.request(actor, 'lsp.v1.diagnostics', params)
      expect(query.mock.lastCall?.[5]).toBe(installation_id)
      await lsp.request(actor, 'lsp.v1.close', params)
      expect(close.mock.lastCall?.[2]).toBe(installation_id)
    }
  } finally {
    await lsp.stop()
    vi.restoreAllMocks()
  }
})
