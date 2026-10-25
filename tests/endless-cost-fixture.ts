import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { SessionSchema } from '@abele/node-protocol'

export function endlessFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'endless-cost-'))
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
  const actor = core.authority.authenticate(core.createToken('cost').token)
  const session = SessionSchema.parse(
    core.request(actor, 'session.create', { title: 'Cost' }, 'create')
  )
  return { dir, core, actor, session }
}
