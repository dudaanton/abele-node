import { expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  chmodSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  snapshotFiles,
  previewFiles,
  restoreFiles,
} from '../packages/node-core/src/chat-checkpoints.js'
import { NodeCore, GitRunner, PiProviderAdapter } from '@abele/node-core'
import { sessionUpdatesOf } from '@abele/node-protocol'

async function checkCheckpointRestores(appendOnly: boolean) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-core-'))),
    root = join(dir, 'root'),
    stateDir = join(dir, 'state')
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'file'), 'before')
  const options = {
    git: new GitRunner(5000, 512 * 1024, 'git'),
    pi: new PiProviderAdapter({ stateDir, profile: 'isolated' }),
  }
  let core = new NodeCore(stateDir, options)
  const token = core.createToken('test').token
  const request = (method: string, p: unknown): any =>
    core.request(core.authority.authenticate(token), method, p, crypto.randomUUID())
  try {
    const project = await request('project.register', { path: root, trust: 'trusted' })
    const catalog = await request('repository.v1.worktrees', { project_id: project.project_id })
    const target = { kind: 'worktree', worktree_id: catalog.entries[0].worktree_id }
    await request('project.execution', { project_id: project.project_id, target, enabled: true })
    const session = await request('session.create', {
      provider: 'pi',
      title: 'checkpoint',
      target,
    })
    const nativeDir = join(stateDir, 'pi-sessions', session.session_id)
    mkdirSync(nativeDir, { recursive: true })
    const file = join(nativeDir, 'original.jsonl')
    writeFileSync(
      file,
      JSON.stringify({ type: 'session', id: '11111111-1111-4111-8111-111111111111', cwd: root }) +
        '\n'
    )
    core.db.prepare('UPDATE sessions SET body=? WHERE session_id=?').run(
      JSON.stringify({
        ...session,
        native_session_id: '11111111-1111-4111-8111-111111111111',
        native_session_file: file,
      }),
      session.session_id
    )
    const input = request('session.send', {
      session_id: session.session_id,
      text: 'original prompt',
      observed_seq: 0,
    })
    expect(
      core
        .read(session.session_id, 0)
        .flatMap((event) => sessionUpdatesOf({ ...event, data: event.data }))
    ).toContainEqual({
      kind: 'user_message',
      message_id: input.input_id,
      text: 'original prompt',
    })
    if (appendOnly) {
      const stat = statSync(file, { bigint: true })
      writeFileSync(file + '.checkpoint-safe', `${stat.dev}:${stat.ino}`)
    }
    // No provider is started in this test: capture the same boundary the dispatcher uses.
    await core.chatCheckpoints.capture(session.session_id, input.input_id)
    core.db.prepare("UPDATE inputs SET state='completed' WHERE input_id=?").run(input.input_id)
    const [checkpoint] = await request('chat.checkpoints', { session_id: session.session_id })
    expect(checkpoint.input_id).toBe(input.input_id)
    expect(checkpoint.exclude_input_ids).toContain(input.input_id)
    writeFileSync(join(root, 'file'), 'after')
    // An upgrade backfills metadata without changing the retained restore snapshot.
    core.db.exec('DROP TABLE chat_checkpoint_summaries')
    await core.resources.stop()
    core.close()
    core = new NodeCore(stateDir, options)
    const p = { session_id: session.session_id, checkpoint_id: checkpoint.checkpoint_id }
    expect(await request('chat.checkpoints', { session_id: session.session_id })).toEqual([
      checkpoint,
    ])
    const preview = await request('chat.preview', p)
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('after')
    await request('chat.restore', { ...p, action: 'rewind' })
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('after')
    expect(readFileSync(file, 'utf8')).toContain('11111111-1111-4111-8111-111111111111')
    writeFileSync(join(root, 'file'), 'later')
    await expect(
      request('chat.restore', {
        ...p,
        action: 'rewind',
        restore_files: { preview_id: preview.preview_id, changes: preview.changes },
      })
    ).rejects.toThrow('stale_revision')
    const latest = await request('chat.preview', p)
    const operation = crypto.randomUUID()
    const restore = {
      ...p,
      action: 'rewind',
      restore_files: { preview_id: latest.preview_id, changes: latest.changes },
    }
    const actor = core.authority.authenticate(token)
    const result = await core.request(actor, 'chat.restore', restore, operation)
    const restoredCount = core
      .read(session.session_id, 0)
      .filter((e) => e.type === 'chat.restored').length
    expect(await core.request(actor, 'chat.restore', restore, operation)).toEqual(result)
    expect(core.read(session.session_id, 0).filter((e) => e.type === 'chat.restored')).toHaveLength(
      restoredCount
    )
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('before')
    // A failure after native filesystem effects leaves an intent, never an automatic replay.
    core.db.prepare("UPDATE inputs SET state='completed' WHERE state='queued'").run()
    const interrupted = crypto.randomUUID()
    core.fault = (point) => {
      if (point === 'before_commit') throw Error('injected commit failure')
    }
    await expect(
      core.request(actor, 'chat.restore', { ...p, action: 'rewind' }, interrupted)
    ).rejects.toThrow('injected commit failure')
    core.fault = undefined
    await core.resources.stop()
    core.close()
    core = new NodeCore(stateDir, options)
    await expect(
      core.request(actor, 'chat.restore', { ...p, action: 'rewind' }, interrupted)
    ).rejects.toThrow('outcome_unknown')
    const branch = await request('chat.restore', { ...p, action: 'branch' })
    expect(branch.session_id).not.toBe(session.session_id)
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('before')
    const edited = await request('chat.restore', {
      ...p,
      action: 'edit',
      text: 'replacement prompt',
    })
    expect(
      JSON.parse(
        String(
          core.db.prepare('SELECT body FROM inputs WHERE input_id=?').get(edited.input.input_id)!
            .body
        )
      ).text
    ).toBe('replacement prompt')
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('before')
  } finally {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
it.each([false, true])(
  'persists pi conversation checkpoints across reopening the node and retries without changing files (append-only: %s)',
  checkCheckpointRestores
)

it('previews creations, edits and deletions, refuses stale/changed previews, restores only explicitly', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-checkpoint-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, 'a'), 'before')
    writeFileSync(join(root, 'removed'), 'keep')
    const before = await snapshotFiles(root)
    chmodSync(join(root, 'a'), 0o700)
    writeFileSync(join(root, 'a'), 'after')
    rmSync(join(root, 'removed'))
    writeFileSync(join(root, 'new'), 'new')
    const changes = previewFiles(before, await snapshotFiles(root))
    expect(changes.map((c) => c.path)).toEqual(['a', 'new', 'removed'])
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('after')
    await expect(restoreFiles(root, before, changes.slice(1))).rejects.toThrow('stale_revision')
    writeFileSync(join(root, 'a'), 'owner edit')
    await expect(restoreFiles(root, before, changes)).rejects.toThrow('stale_revision')
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('owner edit')
    await restoreFiles(root, before, previewFiles(before, await snapshotFiles(root)))
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('before')
    expect(statSync(join(root, 'a')).mode & 0o777).toBe(before.a!.mode)
    expect(await snapshotFiles(root)).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses symlinks and preserves ignored dependencies during file restoration', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-paths-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'dependencies/\n')
    mkdirSync(join(root, 'dependencies'))
    writeFileSync(join(root, 'dependencies', 'local'), 'before')
    const before = await snapshotFiles(root)
    writeFileSync(join(root, 'dependencies', 'local'), 'after')
    expect(previewFiles(before, await snapshotFiles(root))).toEqual([])
    await restoreFiles(root, before, [])
    expect(readFileSync(join(root, 'dependencies', 'local'), 'utf8')).toBe('after')
    symlinkSync(join(root, 'dependencies', 'local'), join(root, 'link'))
    await expect(snapshotFiles(root)).rejects.toThrow('unsafe_path')
    await expect(restoreFiles(root, before, [])).rejects.toThrow('unsafe_path')
    expect(readFileSync(join(root, 'dependencies', 'local'), 'utf8')).toBe('after')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('treats prototype property names as ordinary files after checkpoint deserialization', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-names-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const before = JSON.parse(JSON.stringify(await snapshotFiles(root)))
    writeFileSync(join(root, 'constructor'), 'new')
    writeFileSync(join(root, '__proto__'), 'new')
    const changes = previewFiles(before, await snapshotFiles(root))
    expect(changes.map((c) => c.path)).toEqual(['__proto__', 'constructor'])
    await restoreFiles(root, before, changes)
    expect(await snapshotFiles(root)).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('lets unrelated requests run while Git inventories a checkpoint', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-responsive-')))
  const previous = process.env.PATH
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const git = join(bin, 'git')
    writeFileSync(git, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 150)\n`)
    chmodSync(git, 0o700)
    process.env.PATH = bin
    let responsive = false
    const timer = setTimeout(() => {
      responsive = true
    }, 10)
    await snapshotFiles(root)
    clearTimeout(timer)
    expect(responsive).toBe(true)
  } finally {
    process.env.PATH = previous
    rmSync(root, { recursive: true, force: true })
  }
})
