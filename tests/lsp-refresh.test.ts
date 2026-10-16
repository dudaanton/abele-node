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
