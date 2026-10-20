import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { sessionUpdatesOf } from '@abele/node-protocol'

it('warns once per durable session for explicit missing dependencies without hiding extension failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dependencies-'))
  let core = new NodeCore(dir)
  try {
    const actor = core.authority.authenticate(core.createToken('fixture').token)
    const { session_id } = core.request(actor, 'session.create', {}, 'create') as {
      session_id: string
    }
    core.db
      .prepare("UPDATE sessions SET body=json_set(body,'$.provider','pi') WHERE session_id=?")
      .run(session_id)
    const emit = (error: string, event = 'session_start') =>
      core.execution.appendProviderEvent(session_id, 'turn', {
        type: 'pi.extension.error',
        data: { extension: 'dependencies', event, error },
      })
    const read = () =>
      core
        .read(session_id, 0, 256)
        .flatMap((event) => sessionUpdatesOf({ ...event, data: event.data }))
    emit("ENOENT: no such file or directory, scandir '/project/node_modules'")
    emit("ENOENT: no such file or directory, scandir '/project/node_modules'")
    expect(
      read().filter((u) => u.kind === 'notice' && u.code === 'missing_dependencies')
    ).toHaveLength(1)
    expect(read()).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        level: 'warning',
        text: 'This worktree has no installed dependencies. Install them before running builds or tests.',
      })
    )
    core.close()
    core = new NodeCore(dir)
    emit("ENOENT: no such file or directory, scandir '/project/node_modules'")
    expect(
      read().filter((u) => u.kind === 'notice' && u.code === 'missing_dependencies')
    ).toHaveLength(1)
    emit('server unavailable')
    emit("ENOENT: cannot open '/project/node_modules/tool/index.js'")
    emit('dependencies are missing', 'tool_call')
    expect(read().filter((u) => u.kind === 'notice' && u.level === 'error')).toHaveLength(3)
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
