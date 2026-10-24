import { rmSync } from 'node:fs'
import type { NodeCore } from '../../packages/node-core/src/index.js'

export async function closeRepositoryFixtures(cores: NodeCore[], dirs: string[]) {
  // Claim both lists before yielding. A timed-out hook can overlap the next test.
  const closing = cores.splice(0),
    removing = dirs.splice(0)
  for (const core of closing) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of removing) rmSync(dir, { recursive: true, force: true })
}
