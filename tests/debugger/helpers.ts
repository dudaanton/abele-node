import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'

export const target = {
  node_id: 'fixture-node',
  project_id: 'project',
  workspace_id: null,
  worktree_id: 'worktree',
  conversation_id: 'conversation',
  target_id: 'target',
  adapter_profile: 'fake',
  adapter_version: 'fixture',
  launch_configuration_id: 'config',
  process_ownership: 'unknown' as const,
  build_identity: 'unknown' as const,
}
export function withCore<T>(work: (core: NodeCore, dir: string) => T, enabled = false): T {
  const dir = mkdtempSync(join(tmpdir(), 'debugger-test-'))
  const core = new NodeCore(dir, { debuggerEnabled: enabled })
  try {
    return work(core, dir)
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
