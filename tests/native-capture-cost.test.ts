import { expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { endlessFixture as fixture } from './endless-cost-fixture.js'
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { NodeCore } from '../packages/node-core/src/index.js'
import { ChatCheckpoints } from '../packages/node-core/src/chat-checkpoints.js'
import { writeNative } from '../packages/node-core/src/native-checkpoints.js'

it('keeps native checkpoint metadata constant from a 1 MiB to a 40 MiB conversation and restores its exact prefix', async () => {
  const { dir, core, session } = fixture()
  try {
    const root = join(dir, 'repo')
    mkdirSync(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    const nativeDir = join(core.stateDir, 'pi-sessions', session.session_id)
    mkdirSync(nativeDir, { recursive: true })
    const file = join(nativeDir, 'native.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'original', cwd: root }) + '\n')
    // Same append-only writer contract as the SDK host; rewrites must replace the inode.
    const mark = () => {
      const stat = statSync(file)
      writeFileSync(file + '.checkpoint-safe', `${stat.dev}:${stat.ino}`)
    }
    appendFileSync(file, JSON.stringify({ text: 'x'.repeat(1024 * 1024) }) + '\n')
    mark()
    const fake = {
      ...core,
      db: core.db,
      stateDir: core.stateDir,
      session: () => ({ ...session, provider: 'pi', native_session_file: file }),
      resources: { lsp: { sessionRoot: () => root }, targets: { currentTarget: () => null } },
      head: (s: string) => core.head(s),
      append: (...args: Parameters<NodeCore['append']>) => core.append(...args),
      transaction: <T>(fn: () => T) => core.transaction(fn),
    } as unknown as NodeCore
    const checkpoints = new ChatCheckpoints(fake)
    const sizes: number[] = []
    const times: number[] = []
    for (const growth of [0, 39 * 1024 * 1024]) {
      if (growth) appendFileSync(file, JSON.stringify({ text: 'y'.repeat(growth) }) + '\n')
      const fd = openSync(file, 'r')
      fsyncSync(fd)
      closeSync(fd)
      const start = performance.now()
      await checkpoints.capture(session.session_id, 'input')
      times.push(performance.now() - start)
      const row = core.db
        .prepare('SELECT body FROM chat_checkpoints ORDER BY rowid DESC LIMIT 1')
        .get()
      expect(row).toBeDefined()
      sizes.push(Buffer.byteLength(String(row!.body)))
      expect(sizes.at(-1)).toBeLessThan(2048)
    }
    const rows = core.db.prepare('SELECT body FROM chat_checkpoints ORDER BY rowid').all()
    appendFileSync(file, JSON.stringify({ text: 'future' }) + '\n')
    for (const [index, row] of rows.entries()) {
      const checkpoint = JSON.parse(String(row.body))
      const output = join(nativeDir, `restore-${index}.jsonl`)
      writeNative(core.stateDir, checkpoint.native, output, 'restored', root)
      const restored = readFileSync(output)
      const original = readFileSync(file).subarray(0, checkpoint.native.bytes)
      const digest = (bytes: Buffer) =>
        createHash('sha256')
          .update(bytes.subarray(bytes.indexOf(10) + 1))
          .digest('hex')
      expect(digest(restored)).toBe(digest(original))
      expect(restored.includes(Buffer.from('future'))).toBe(false)
    }
    expect(Math.abs(sizes[1]! - sizes[0]!)).toBeLessThan(32)
    expect(
      core.read(session.session_id, 0).filter((e) => e.type === 'chat.checkpoint.unavailable')
    ).toEqual([])
    console.log('native capture ms / stored bytes, 1 MiB then 40 MiB:', times, sizes)
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
