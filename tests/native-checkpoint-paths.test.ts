import { expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  realpathSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  captureNative,
  writeNative,
  NativeCheckpointRoot,
} from '../packages/node-core/src/native-checkpoints.js'
import {
  snapshotFiles,
  restoreFiles,
  previewFiles,
} from '../packages/node-core/src/chat-checkpoints.js'
import { markAppendOnlyNative } from '../packages/provider-pi/src/native-state.js'

function fixture() {
  const dir = mkdtempSync(resolve('.scratch/native-paths-'))
  const physical = join(dir, 'private', 'var')
  mkdirSync(physical, { recursive: true })
  symlinkSync(physical, join(dir, 'var'))
  const state = join(dir, 'var', 'tmp', 'state')
  const session = 'session'
  const parent = join(state, 'pi-sessions', session)
  mkdirSync(parent, { recursive: true })
  const file = join(parent, 'native.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session', id: 'original' }) + '\n')
  markAppendOnlyNative(file)
  return { dir, state, session, parent, file }
}

it('captures and restores a native prefix through a macOS-shaped /var ancestor alias', () => {
  const f = fixture()
  try {
    const checkpoint = captureNative(f.state, f.session, f.file)
    expect(typeof checkpoint).toBe('object')
    const output = join(f.parent, 'restored.jsonl')
    writeNative(f.state, checkpoint, output, 'restored', 'repo')
    expect(JSON.parse(readFileSync(output, 'utf8')).id).toBe('restored')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it('pins a trusted repository alias before snapshot inventory and file restore', async () => {
  const f = fixture()
  try {
    const root = join(f.dir, 'var', 'tmp', 'repo')
    mkdirSync(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, 'file'), 'before')
    const before = await snapshotFiles(root)
    writeFileSync(join(root, 'file'), 'after')
    await restoreFiles(root, before, previewFiles(before, await snapshotFiles(root)))
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('before')
    renameSync(join(root, 'file'), join(root, 'original'))
    symlinkSync(join(root, 'original'), join(root, 'file'))
    await expect(snapshotFiles(root)).rejects.toThrow('unsafe_path')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it.each(['file', 'session', 'archive'] as const)(
  'refuses a substituted %s below the trusted native root',
  (kind) => {
    const f = fixture()
    try {
      const source =
        kind === 'file'
          ? f.file
          : kind === 'session'
            ? f.parent
            : join(f.state, 'native-checkpoints')
      if (kind === 'archive') mkdirSync(source)
      renameSync(source, source + '-original')
      symlinkSync(source + '-original', source)
      expect(() => captureNative(f.state, f.session, f.file)).toThrow('unsafe_path')
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  }
)

it('keeps an initialized native store pinned when a trusted ancestor alias is retargeted', () => {
  const f = fixture()
  try {
    const root = new NativeCheckpointRoot(f.state)
    const file = realpathSync(f.file)
    const otherVar = join(f.dir, 'other-var')
    const otherSession = join(otherVar, 'tmp', 'state', 'pi-sessions', f.session)
    mkdirSync(otherSession, { recursive: true })
    writeFileSync(
      join(otherSession, 'native.jsonl'),
      JSON.stringify({ type: 'session', id: 'other' }) + '\n'
    )
    unlinkSync(join(f.dir, 'var'))
    symlinkSync(otherVar, join(f.dir, 'var'))
    const checkpoint = captureNative(root, f.session, file)
    expect(typeof checkpoint).toBe('object')
    expect(existsSync(join(otherVar, 'tmp', 'state', 'native-checkpoints'))).toBe(false)
    expect(() => captureNative(root, f.session, f.file)).toThrow('unsafe_path')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it('refuses replacement of the physical state directory after startup', () => {
  const f = fixture()
  try {
    const state = realpathSync(f.state)
    const root = new NativeCheckpointRoot(state, { canonical: true })
    renameSync(state, state + '-original')
    symlinkSync(state + '-original', state)
    expect(() => captureNative(root, f.session, f.file)).toThrow('unsafe_path')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'keeps restore pinned across alias retargeting and rejects physical root substitution (physical: %s)',
  async (physical) => {
    const f = fixture()
    try {
      const root = join(f.dir, 'var', 'tmp', 'repo')
      mkdirSync(root)
      execFileSync('git', ['init', '-q'], { cwd: root })
      writeFileSync(join(root, 'file'), 'before')
      const before = await snapshotFiles(root)
      writeFileSync(join(root, 'file'), 'after')
      const actual = realpathSync(root)
      const other = join(f.dir, 'other-var')
      mkdirSync(join(other, 'tmp', 'repo'), { recursive: true })
      writeFileSync(join(other, 'tmp', 'repo', 'file'), 'untouched')
      const changes = previewFiles(before, await snapshotFiles(root))
      const restore = restoreFiles(root, before, changes, () => {
        if (physical) {
          renameSync(actual, actual + '-original')
          symlinkSync(join(other, 'tmp', 'repo'), actual)
        } else {
          unlinkSync(join(f.dir, 'var'))
          symlinkSync(other, join(f.dir, 'var'))
        }
      })
      if (physical) await expect(restore).rejects.toThrow('unsafe_path')
      else {
        await restore
        expect(readFileSync(join(actual, 'file'), 'utf8')).toBe('before')
      }
      expect(readFileSync(join(other, 'tmp', 'repo', 'file'), 'utf8')).toBe('untouched')
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  }
)
