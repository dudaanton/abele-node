import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, appendFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import {
  installAtomicNativeWrites,
  materializeNativeState,
  markAppendOnlyNative,
} from '../packages/provider-pi/src/native-state.js'
import { captureNative, writeNative } from '../packages/node-core/src/native-checkpoints.js'

it('preserves checkpoint prefixes across appends, in-place SDK rewrites, reopen and repeated captures without a link per turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-native-prefix-'))
  const session = 'session'
  const root = join(dir, 'pi-sessions', session)
  mkdirSync(root, { recursive: true })
  try {
    // Only the local SessionManager library is used: no model, credentials or CLI.
    expect(installAtomicNativeWrites(SessionManager)).toBe(true)
    const manager = SessionManager.create(dir, root)
    materializeNativeState(manager)
    const file = manager.getSessionFile()!
    markAppendOnlyNative(file)
    manager.appendCustomEntry('fixture', { text: 'before' })
    const original = readFileSync(file, 'utf8')
    const checkpoint = captureNative(dir, session, file)
    expect(typeof checkpoint).toBe('object')
    for (let i = 0; i < 1000; i++) expect(captureNative(dir, session, file)).toEqual(checkpoint)
    expect(statSync(file).nlink).toBe(2)
    manager.appendCustomEntry('fixture', { text: 'after' })
    const appended = captureNative(dir, session, file)
    // Simulate an SDK migration rewriting an earlier entry through its sole truncating writer.
    ;(manager.getEntries()[0] as any).data.text = 'rewritten'
    ;(manager as any)._rewriteFile()
    expect(statSync(file).ino).not.toBe(
      statSync(join(dir, 'native-checkpoints', (checkpoint as any).file)).ino
    )
    const rewritten = captureNative(dir, session, file)
    expect((rewritten as any).file).not.toBe((checkpoint as any).file)
    appendFileSync(file, JSON.stringify({ type: 'future' }) + '\n')
    for (const [native, suffix] of [
      [checkpoint, 'old'],
      [appended, 'appended'],
      [rewritten, 'rewritten'],
    ] as const) {
      const output = join(root, suffix + '.jsonl')
      writeNative(dir, native, output, suffix, dir)
      const [, ...lines] = readFileSync(output, 'utf8').trimEnd().split('\n')
      expect(readFileSync(output, 'utf8')).not.toContain('future')
      expect(JSON.parse(readFileSync(output, 'utf8').split('\n')[0]!).id).toBe(suffix)
      if (suffix === 'old')
        expect(lines.join('\n')).toBe(original.trimEnd().split('\n').slice(1).join('\n'))
      if (suffix === 'appended')
        expect(lines.map((l) => JSON.parse(l).data.text)).toEqual(['before', 'after'])
      if (suffix === 'rewritten')
        expect(lines.map((l) => JSON.parse(l).data.text)).toEqual(['rewritten', 'after'])
      const reopened = SessionManager.open(output, root, dir)
      expect(reopened.getEntries().length).toBe(suffix === 'old' ? 1 : 2)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
