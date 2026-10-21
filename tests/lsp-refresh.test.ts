import { expect, it, vi } from 'vitest'
import { NodeLsp } from '../packages/node-core/src/lsp/node.js'

vi.mock('../packages/node-core/src/lsp/servers.js', async (original) => ({
  ...(await original<any>()),
  discover: () => null,
}))

it('does not spawn Git after a turn when no language server can consume the changes', async () => {
  const run = vi.fn(async () => Buffer.from(''))
  const lsp = new NodeLsp({ core: { stateDir: '/unused' }, git: { run } } as any)
  vi.spyOn(lsp, 'sessionRoot').mockReturnValue(process.cwd())
  try {
    await lsp.afterEdit('session')
    expect(run).not.toHaveBeenCalled()
  } finally {
    await lsp.stop()
  }
})

it('publishes diagnostics to file consumers without appending unsolicited chat notices', () => {
  const append = vi.fn()
  const r = {
    core: {
      stateDir: '/unused',
      append,
      transaction: (f: any) => f(),
      db: { prepare: () => ({ all: () => [{ session_id: 'chat' }] }) },
    },
  }
  const lsp = new NodeLsp(r as any)
  ;(lsp as any).roots.set('/root', { id: 'workspace', repository: false, project: 'project' })
  vi.spyOn(lsp, 'sessionRoot').mockReturnValue('/root')
  ;(lsp.service as any).options.diagnostics('/root', 'a.ts', [])
  expect(append.mock.calls.map((call) => call[0])).toEqual(['catalog'])
})

it('addresses language-analysis failure notices to the correct repository worktree', () => {
  const append = vi.fn(),
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lsp = new NodeLsp({
    core: { stateDir: '/unused', append, transaction: (f: any) => f() },
  } as any)
  ;(lsp as any).roots.set('/root', { id: 'worktree', repository: true, project: 'project' })
  try {
    ;(lsp.service as any).options.error('/root', 'typescript stopped after repeated crash')
    expect(append).toHaveBeenCalledWith(
      'catalog',
      'lsp.status',
      { kind: 'node' },
      { worktree_id: 'worktree', message: 'typescript stopped after repeated crash' }
    )
    expect(warn).toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
