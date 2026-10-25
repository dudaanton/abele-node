import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeCore } from '@abele/node-core'
import { SessionSchema, ChatMethodSchemas } from '@abele/node-protocol'
import { ChatClient } from '../packages/node-client/src/chat.js'

it('bounds checkpoint reads and uses an indexed seek for short and multi-thousand-turn sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-paging-'))
  let core = new NodeCore(dir)
  const token = core.createToken('paging').token
  const actor = core.authority.authenticate(token)
  const session = SessionSchema.parse(
    core.request(actor, 'session.create', { title: 'Paging' }, 'create')
  )
  core.db
    .prepare('UPDATE sessions SET body=? WHERE session_id=?')
    .run(JSON.stringify({ ...session, provider: 'pi' }), session.session_id)
  const metadata = (seq: number) => ({
    checkpoint_id: `checkpoint-${seq}`,
    input_id: `input-${seq}`,
    before_seq: seq,
    exclude_input_ids: [],
  })
  const insert = (from: number, to: number) =>
    core.transaction(() => {
      const statement = core.db.prepare('INSERT INTO chat_checkpoints VALUES(?,?,?)')
      for (let seq = from; seq <= to; seq++) {
        statement.run(
          `checkpoint-${seq}`,
          session.session_id,
          JSON.stringify({
            ...metadata(seq),
            seq,
            native: 'large native snapshot'.repeat(100),
            files: {},
          })
        )
        core.db
          .prepare('INSERT INTO chat_checkpoint_summaries VALUES(?,?,?,?)')
          .run(`checkpoint-${seq}`, session.session_id, seq, JSON.stringify(metadata(seq)))
      }
    })
  const page = (options = {}) =>
    core.request(actor, 'chat.checkpoints', {
      session_id: session.session_id,
      ...options,
    }) as Promise<ReturnType<typeof metadata>[]>
  try {
    insert(1, 10)
    const parse = vi.spyOn(JSON, 'parse')
    const short = await page({ after_seq: 0, limit: 5 })
    const shortParses = parse.mock.calls.length
    parse.mockRestore()
    expect(short).toEqual([1, 2, 3, 4, 5].map(metadata))
    insert(11, 5000)
    // Reopen a legacy-shaped database with all historical rows and no paging index.
    core.db.exec('DROP TABLE chat_checkpoint_summaries')
    await core.resources.stop()
    core.close()
    core = new NodeCore(dir)
    const prepare = vi.spyOn(core.db, 'prepare')
    const longParse = vi.spyOn(JSON, 'parse')
    expect(await page({ after_seq: 4990, limit: 5 })).toEqual(
      [4991, 4992, 4993, 4994, 4995].map(metadata)
    )
    expect(longParse.mock.calls.length).toBe(shortParses)
    longParse.mockRestore()
    const sql = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('FROM chat_checkpoint_summaries'))!
    prepare.mockRestore()
    const plan = core.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(session.session_id, 4990, 5)
    expect(JSON.stringify(plan)).toContain('chat_checkpoints_session_seq')
    expect(JSON.stringify(plan)).not.toMatch(/SCAN |TEMP B-TREE/)
    expect(await page({ before_seq: 7, limit: 3 })).toEqual([4, 5, 6].map(metadata))
    expect(await page({ after_seq: 4998, limit: 5 })).toEqual([4999, 5000].map(metadata))
    expect(await page({ before_seq: 1 })).toEqual([])
    const latest = await page()
    expect(latest).toHaveLength(100)
    expect(latest[0]).toEqual(metadata(4901))
    expect(latest[99]).toEqual(metadata(5000))
    expect(core.db.prepare('SELECT count(*) AS n FROM chat_checkpoints').get()!.n).toBe(5000)
    let before_seq = latest[0]!.before_seq
    let count = latest.length
    for (;;) {
      const older = await page({ before_seq })
      if (!older.length) break
      expect(older.at(-1)!.before_seq).toBe(before_seq - 1)
      before_seq = older[0]!.before_seq
      count += older.length
    }
    expect(count).toBe(5000)
    core.db
      .prepare('INSERT INTO chat_checkpoint_summaries VALUES(?,?,?,?)')
      .run('other-checkpoint', 'other-session', 5001, JSON.stringify(metadata(5001)))
    expect(await page({ after_seq: 5000 })).toEqual([])

    // Page bytes are bounded too, in either direction, without skipping the next row.
    const update = core.db.prepare(
      'UPDATE chat_checkpoint_summaries SET body=? WHERE checkpoint_id=?'
    )
    for (const seq of [1, 2, 3])
      update.run(
        JSON.stringify({
          ...metadata(seq),
          exclude_input_ids: Array(1000).fill('i'.repeat(100)),
        }),
        `checkpoint-${seq}`
      )
    expect((await page({ after_seq: 0, limit: 3 })).map((c) => c.before_seq)).toEqual([1, 2])
    expect((await page({ before_seq: 4, limit: 3 })).map((c) => c.before_seq)).toEqual([2, 3])
    expect((await page({ after_seq: 2, limit: 1 }))[0]!.before_seq).toBe(3)
    update.run(
      JSON.stringify({
        ...metadata(1),
        exclude_input_ids: Array(3500).fill('i'.repeat(100)),
      }),
      'checkpoint-1'
    )
    await expect(page({ after_seq: 0 })).rejects.toThrow('output_limit')
  } finally {
    vi.restoreAllMocks()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('validates checkpoint cursors and forwards paging options through the SDK', async () => {
  const schema = ChatMethodSchemas['chat.checkpoints']
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { after_seq: -1 },
    { before_seq: 1.5 },
    { after_seq: Number.MAX_SAFE_INTEGER + 1 },
    { before_seq: 5, after_seq: 1 },
  ])
    expect(schema.safeParse({ session_id: 's', ...options }).success).toBe(false)
  const rpc = vi.fn(async (_method: string, _params: unknown) => [])
  const client = new ChatClient(rpc)
  await client.checkpoints('s', { after_seq: 20, limit: 10 })
  expect(rpc).toHaveBeenLastCalledWith('chat.checkpoints', {
    session_id: 's',
    after_seq: 20,
    limit: 10,
  })
  await client.checkpoints('s')
  expect(rpc.mock.calls).toHaveLength(2)
})
