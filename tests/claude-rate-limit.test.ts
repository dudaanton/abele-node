import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore } from '@abele/node-core'
import { sessionUpdatesOf } from '@abele/node-protocol'

it('emits usage-limit changes once across turns and restarts, with reset time as data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-rate-limit-'))
  let core = new NodeCore(dir)
  try {
    const actor = core.authority.authenticate(core.createToken('test').token)
    const create = () =>
      (
        core.request(actor, 'session.create', { title: 'limit' }, randomUUID()) as {
          session_id: string
        }
      ).session_id
    const session = create()
    const other = create()
    for (const id of [session, other])
      core.db
        .prepare(
          "UPDATE sessions SET body=json_set(body, '$.provider', 'claude') WHERE session_id=?"
        )
        .run(id)
    const emit = (id: string, status: string, resetsAt?: number, run = 'turn-1') =>
      core.execution.appendProviderEvent(id, run, {
        type: 'claude.rate_limit',
        data: { info: { status, resetsAt } },
      })
    const warnings = (id: string) =>
      core
        .read(id, 0, 256)
        .flatMap((event) => sessionUpdatesOf({ ...event, data: event.data }))
        .filter((u) => u.kind === 'notice' && u.code === 'rate_limit')
    emit(session, 'allowed_warning', 1_800_000_000)
    emit(session, 'allowed_warning', 1_800_000_000, 'turn-2')
    expect(warnings(session)).toHaveLength(1)
    expect(warnings(session)[0]).toMatchObject({
      status: 'allowed_warning',
      resets_at: 1_800_000_000,
    })
    emit(other, 'allowed_warning', 1_800_000_000)
    expect(warnings(other)).toHaveLength(1)
    core.close()
    core = new NodeCore(dir)
    emit(session, 'allowed_warning', 1_800_000_000, 'turn-3')
    expect(warnings(session)).toHaveLength(1)
    emit(session, 'allowed_warning', 1_800_000_001)
    emit(session, 'allowed', 1_800_000_001)
    emit(session, 'allowed_warning', 1_800_000_001)
    emit(session, 'rejected', 1_800_000_001)
    expect(warnings(session)).toHaveLength(4)
    expect(warnings(session).at(-1)).toMatchObject({ level: 'error' })
    // Rejections remain actionable on every attempt; returning to warning changes state.
    emit(session, 'rejected', 1_800_000_001)
    emit(session, 'allowed_warning', 1_800_000_001)
    expect(warnings(session)).toHaveLength(6)
    emit(session, 'allowed_warning')
    emit(session, 'allowed_warning')
    expect(warnings(session)).toHaveLength(7)
    expect(warnings(session).at(-1)).toMatchObject({ resets_at: null })
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
