import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { NodeCore } from '@abele/node-core'
it('forward-migrates pi native mapping without losing identity, receipts or history and fences older daemons', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-migration-'))
  let core: NodeCore | undefined = new NodeCore(dir)
  try {
    const token = core.createToken('test'),
      actor = core.authority.authenticate(token.token)
    const session = core.request(actor, 'session.create', { title: 'existing' }, 'create') as {
      session_id: string
    }
    const identity = core.node_id,
      history = core.read(session.session_id, 0),
      native = randomUUID(),
      file = join(dir, 'pi-sessions', session.session_id, 'native.jsonl')
    core.close()
    core = undefined
    const db = new DatabaseSync(join(dir, 'node.sqlite'))
    const body = JSON.parse(
      String(
        db.prepare('SELECT body FROM sessions WHERE session_id=?').get(session.session_id)!.body
      )
    )
    db.prepare('UPDATE sessions SET body=? WHERE session_id=?').run(
      JSON.stringify({
        ...body,
        provider: 'pi',
        native_session_id: native,
        native_session_file: file,
      }),
      session.session_id
    )
    db.exec(
      'DROP TABLE delegation_reports; DROP TABLE delegations; DROP TABLE delegation_grants; DROP TABLE IF EXISTS provider_native_sessions; PRAGMA user_version=9;'
    )
    db.close()
    core = new NodeCore(dir)
    expect(core.db.prepare('PRAGMA user_version').get()!.user_version).toBe(11)
    expect(core.db.prepare('SELECT * FROM provider_native_sessions').get()).toMatchObject({
      session_id: session.session_id,
      native_session_id: native,
      session_file: file,
    })
    expect(core.node_id).toBe(identity)
    expect(core.read(session.session_id, 0)).toEqual(history)
    expect(core.request(actor, 'session.create', { title: 'existing' }, 'create')).toEqual(session)
    core.close()
    core = undefined
    const future = new DatabaseSync(join(dir, 'node.sqlite'))
    future.exec('PRAGMA user_version=12')
    future.close()
    expect(() => new NodeCore(dir)).toThrow(/unsupported_database_version/)
  } finally {
    core?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
