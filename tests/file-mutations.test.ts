import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  chmodSync,
  statSync,
  fsyncSync,
  openSync,
  closeSync,
  writeSync,
  chownSync,
  renameSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const posixMetadata = (path: string) => {
  const stat = statSync(path)
  return { mode: stat.mode & 0o777, ino: stat.ino, uid: stat.uid, gid: stat.gid }
}
const roots: string[] = [],
  cores: NodeCore[] = []
async function setup(stateThroughAlias = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/mutations-')),
    repo = join(dir, 'folder')
  roots.push(dir)
  mkdirSync(repo)
  writeFileSync(join(repo, 'sample.txt'), 'before')
  let state = join(dir, 'state')
  if (stateThroughAlias) {
    mkdirSync(join(dir, 'physical-state-parent'))
    symlinkSync(join(dir, 'physical-state-parent'), join(dir, 'state-parent-alias'))
    state = join(dir, 'state-parent-alias', 'not-created', 'state')
  }
  const core = new NodeCore(state)
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const project = (await core.request(
    actor,
    'project.register',
    { path: repo, trust: 'untrusted' },
    'register'
  )) as { project_id: string }
  const [w] = (await core.request(actor, 'workspace.list', { project_id: project.project_id })) as {
    workspace_id: string
  }[]
  const params: {
    workspace_id: string
    path: string
    expected_content_id: string | null
    text: string
  } = {
    workspace_id: w!.workspace_id,
    path: 'sample.txt',
    expected_content_id: hash('before'),
    text: 'after',
  }
  const save = async (id = 'save', p = params) => core.request(actor, 'workspace.write', p, id)
  return { dir, repo, core, actor, params, save }
}
type Receipt = {
  state: string
  recovery_path: string | null
  predecessor_content_id: string | null
}
function recovery(s: Awaited<ReturnType<typeof setup>>, receipt: Receipt) {
  return join(s.dir, 'state', receipt.recovery_path!)
}
function diskCopies(s: Awaited<ReturnType<typeof setup>>) {
  const directory = join(s.dir, 'state', 'file-recovery', s.params.workspace_id)
  return existsSync(directory) ? readdirSync(directory).map((name) => join(directory, name)) : []
}
function schema8(s: Awaited<ReturnType<typeof setup>>) {
  s.core.close()
  const db = new DatabaseSync(join(s.dir, 'state', 'node.sqlite'))
  db.exec(
    'DROP TABLE delegation_reports; DROP TABLE delegations; DROP TABLE delegation_grants; DROP TABLE IF EXISTS provider_native_sessions; DROP TABLE codex_thread_bindings; CREATE TABLE IF NOT EXISTS legacy_file_recoveries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), path TEXT NOT NULL, content_id TEXT NOT NULL, fingerprint TEXT NOT NULL, protected INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id,path)); PRAGMA user_version=8;'
  )
  return db
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
it('saves with a retained predecessor and one bounded invalidation; retry never reapplies', async () => {
  const s = await setup(),
    ino = statSync(join(s.repo, 'sample.txt')).ino
  const receipt = (await s.save()) as Receipt
  expect(receipt).toMatchObject({
    state: 'saved',
    predecessor_content_id: hash('before'),
    content_id: hash('after'),
  })
  expect(statSync(join(s.repo, 'sample.txt')).ino).toBe(ino)
  expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
  expect(readdirSync(s.repo)).toEqual(['sample.txt'])
  writeFileSync(join(s.repo, 'sample.txt'), 'later')
  expect(await s.save()).toEqual(receipt)
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('later')
  const events = s.core
    .read('catalog', 0)
    .filter(
      (e) =>
        e.type === 'workspace.changed' && (e.data as { reason?: string }).reason === 'file_mutation'
    )
  expect(events).toHaveLength(1)
  expect(JSON.stringify(events[0]).length).toBeLessThan(8192)
  await expect(s.save('save', { ...s.params, text: 'different' })).rejects.toThrow(
    'idempotency_mismatch'
  )
})
it('repeated saves and recovery reads work when a missing state dir has a symlinked ancestor', async () => {
  const s = await setup(true)
  const first = (await s.save()) as Receipt
  expect(first.state).toBe('saved')
  const second = (await s.save('second-save', {
    ...s.params,
    expected_content_id: hash('after'),
    text: 'second',
  })) as Receipt
  expect(second.state).toBe('saved')
  expect(s.core.stateDir).toBe(realpathSync(join(s.dir, 'physical-state-parent/not-created/state')))
  const copy = (await s.core.request(s.actor, 'workspace.recovery.read', {
    workspace_id: s.params.workspace_id,
    recovery_path: first.recovery_path,
    offset: 0,
    length: 1024,
  })) as { base64: string }
  expect(Buffer.from(copy.base64, 'base64').toString()).toBe('before')
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('second')
})
it('state is pinned at startup even if its parent alias is retargeted later', async () => {
  const s = await setup(true)
  expect(await s.save()).toMatchObject({ state: 'saved' })
  const replacement = join(s.dir, 'replacement')
  mkdirSync(replacement)
  rmSync(join(s.dir, 'state-parent-alias'))
  symlinkSync(replacement, join(s.dir, 'state-parent-alias'))
  expect(
    await s.save('after-retarget', {
      ...s.params,
      expected_content_id: hash('after'),
      text: 'still pinned',
    })
  ).toMatchObject({ state: 'saved' })
  expect(readdirSync(replacement)).toEqual([])
})
it('canonical state paths do not permit recovery-directory symlink replacement', async () => {
  const s = await setup()
  expect(await s.save()).toMatchObject({ state: 'saved' })
  const recoveryRoot = join(s.core.stateDir, 'file-recovery')
  const moved = join(s.dir, 'moved-recovery')
  renameSync(recoveryRoot, moved)
  symlinkSync(moved, recoveryRoot)
  await expect(
    s.save('replaced-recovery', {
      ...s.params,
      expected_content_id: hash('after'),
      text: 'must not write',
    })
  ).rejects.toThrow('unsafe_path')
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('after')
})
it('external edits conflict without touching them at the final base check', async () => {
  const s = await setup()
  s.core.resources.mutations.fault = (point) => {
    if (point === 'before_check') writeFileSync(join(s.repo, 'sample.txt'), 'external')
  }
  expect(await s.save()).toMatchObject({
    state: 'conflict',
    predecessor_content_id: hash('external'),
  })
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('external')
  expect(s.core.resources.files.bytes(s.params.workspace_id, hash('external')).toString()).toBe(
    'external'
  )
  s.core.resources.mutations.fault = undefined
  expect(await s.save('stale')).toMatchObject({ state: 'conflict' })
})
it('does not overwrite a replacement pathname created by an external editor during a write', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_truncate') {
      renameSync(target, join(s.repo, 'editor-old.txt'))
      writeFileSync(target, 'competing')
    }
  }
  const receipt = (await s.save()) as Receipt
  expect(receipt.state).toBe('outcome_unknown')
  expect(readFileSync(target, 'utf8')).toBe('competing')
  expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
})
it.each(['after_truncate', 'after_write'] as const)(
  'restart after %s retains evidence and never repeats the write',
  async (point) => {
    const s = await setup()
    s.core.resources.mutations.fault = (p) => {
      if (p === point) throw new Error('crash')
    }
    await expect(s.save()).rejects.toThrow('crash')
    await expect(
      Promise.resolve().then(() =>
        s.core.request(s.actor, 'session.create', { title: 'collision' }, 'save')
      )
    ).rejects.toThrow('idempotency_mismatch')
    expect(readdirSync(s.repo)).toEqual(['sample.txt'])
    s.core.close()
    const recovered = new NodeCore(join(s.dir, 'state'))
    cores.push(recovered)
    const receipt = (await recovered.request(
      s.actor,
      'workspace.write',
      s.params,
      'save'
    )) as Receipt
    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      predecessor_content_id: hash('before'),
    })
    expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
    writeFileSync(join(s.repo, 'sample.txt'), 'later')
    expect(await recovered.request(s.actor, 'workspace.write', s.params, 'save')).toEqual(receipt)
    expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('later')
  }
)
it('same-process uncertain retry keeps the original recovery copy and the current competing bytes', async () => {
  const s = await setup()
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_write') {
      writeFileSync(join(s.repo, 'sample.txt'), 'external')
      throw new Error('response lost')
    }
  }
  await expect(s.save()).rejects.toThrow('response lost')
  s.core.resources.mutations.fault = undefined
  const receipt = (await s.save()) as Receipt
  expect(receipt).toMatchObject({
    state: 'outcome_unknown',
    predecessor_content_id: hash('before'),
  })
  expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('external')
})
it('preserves file permission bits independently of the daemon umask', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  chmodSync(target, 0o751)
  const previous = process.umask(0o077)
  try {
    await s.save()
  } finally {
    process.umask(previous)
  }
  expect(statSync(target).mode & 0o777).toBe(0o751)
})
it('late descriptor writes remain on the live inode and verification reports uncertainty', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt'),
    fd = openSync(target, 'r+')
  try {
    s.core.resources.mutations.fault = (p) => {
      if (p === 'after_write') writeSync(fd, Buffer.from('late edit'), 0, 9, 0)
    }
    const receipt = (await s.save()) as Receipt
    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      predecessor_content_id: hash('before'),
    })
    expect(readFileSync(target, 'utf8')).toBe('late edit')
    expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
  } finally {
    closeSync(fd)
  }
})
it('a descriptor held across a confirmed save still writes the live file; copies are bounded', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt'),
    fd = openSync(target, 'r+')
  let first!: Receipt
  try {
    first = (await s.save()) as Receipt
    writeSync(fd, Buffer.from('late edit'), 0, 9, 0)
  } finally {
    closeSync(fd)
  }
  expect(readFileSync(target, 'utf8')).toBe('late edit')
  expect(readFileSync(recovery(s, first), 'utf8')).toBe('before')
  for (let i = 0; i < 35; i++)
    await s.save('copy-' + i, {
      ...s.params,
      expected_content_id: hash(readFileSync(target, 'utf8')),
      text: 'next ' + i,
    })
  expect(readdirSync(s.repo)).toEqual(['sample.txt'])
  const copies = s.core.db
    .prepare('SELECT * FROM file_recovery_copies WHERE workspace_id=?')
    .all(s.params.workspace_id)
  expect(copies.length).toBeLessThanOrEqual(32)
  expect(diskCopies(s).length).toBeLessThanOrEqual(32)
  expect(diskCopies(s).length).toBe(copies.length)
  expect(existsSync(recovery(s, first))).toBe(false)
})
it.each([0o600, 0o755])(
  'keeps concurrent permission changes (%i) without replacement',
  async (mode) => {
    const s = await setup(),
      target = join(s.repo, 'sample.txt')
    chmodSync(target, 0o644)
    s.core.resources.mutations.fault = (p) => {
      if (p === 'before_check') chmodSync(target, mode)
    }
    expect(await s.save()).toMatchObject({ state: 'saved' })
    expect(statSync(target).mode & 0o777).toBe(mode)
  }
)
it('preserves owner and group on the existing inode', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt'),
    original = statSync(target),
    gid = process.getgroups!().find((g) => g !== original.gid)!
  expect(gid).toBeDefined()
  chownSync(target, original.uid, gid)
  expect(await s.save()).toMatchObject({ state: 'saved' })
  expect(statSync(target)).toMatchObject({ uid: original.uid, gid, ino: original.ino })
})
it.each(['acl', 'xattr'])('saves without dropping existing %s metadata', async (kind) => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  if (process.platform === 'darwin') {
    const added =
      kind === 'acl'
        ? spawnSync('/bin/chmod', ['+a', 'user:nobody deny read', target], { encoding: 'utf8' })
        : spawnSync('/usr/bin/xattr', ['-w', 'sample.attribute', 'retained', target], {
            encoding: 'utf8',
          })
    expect(added.status, added.stderr).toBe(0)
  } else {
    // Writes are portable, so these cases must run on Linux too. Check its POSIX
    // metadata instead of invoking macOS-only attribute tools or skipping the save.
    expect(process.platform).toBe('linux')
    const mode = kind === 'acl' ? 0o751 : 0o640
    chmodSync(target, mode)
    expect(posixMetadata(target).mode).toBe(mode)
  }
  // Compare stable ACL identifiers, not directory-service names that may resolve
  // to user:nobody on one lookup and its UUID on the next without any ACL change.
  const inspect = () =>
    process.platform === 'linux'
      ? JSON.stringify(posixMetadata(target))
      : kind === 'acl'
        ? spawnSync('/bin/ls', ['-len', target], { encoding: 'utf8' })
            .stdout.split('\n')
            .slice(1)
            .join('\n')
        : spawnSync('/usr/bin/xattr', ['-p', 'sample.attribute', target], { encoding: 'utf8' })
            .stdout
  const metadata = inspect(),
    posix = posixMetadata(target)
  expect(metadata).not.toBe('')
  expect(await s.save()).toMatchObject({ state: 'saved' })
  expect(inspect()).toBe(metadata)
  expect(posixMetadata(target)).toEqual(posix)
  expect(readFileSync(target, 'utf8')).toBe('after')
  expect(readdirSync(s.repo)).toEqual(['sample.txt'])
})
it('ordinary platform metadata survives saves: macOS attributes or Linux POSIX modes', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  if (process.platform === 'linux') {
    for (const mode of [0o600, 0o640, 0o751]) {
      const before = readFileSync(target, 'utf8'),
        text = `after-${mode}`
      chmodSync(target, mode)
      const metadata = posixMetadata(target)
      expect(metadata.mode).toBe(mode)
      const receipt = (await s.save(`mode-${mode}`, {
        ...s.params,
        expected_content_id: hash(before),
        text,
      })) as Receipt
      expect(receipt.state).toBe('saved')
      expect(posixMetadata(target)).toEqual(metadata)
      expect(readFileSync(target, 'utf8')).toBe(text)
      expect(readFileSync(recovery(s, receipt), 'utf8')).toBe(before)
      expect(readdirSync(s.repo)).toEqual(['sample.txt'])
    }
    return
  }
  expect(process.platform).toBe('darwin')
  const metadata = posixMetadata(target)
  const attrs = {
    'com.apple.quarantine': '303038333b30303030303030303b666978747572653b',
    'com.apple.FinderInfo': '0000000000000000000000000000000000000000000000000000000000000001',
    'com.apple.lastuseddate#PS': '00000000000000000000000000000000',
  }
  const values = new Map<string, string>()
  for (const [name, value] of Object.entries(attrs)) {
    const added = spawnSync('/usr/bin/xattr', ['-wx', name, value, target], { encoding: 'utf8' })
    expect(added.status, added.stderr).toBe(0)
    values.set(
      name,
      spawnSync('/usr/bin/xattr', ['-px', name, target], { encoding: 'utf8' }).stdout
    )
  }
  expect(await s.save()).toMatchObject({ state: 'saved' })
  expect(posixMetadata(target)).toEqual(metadata)
  for (const [name, value] of values)
    expect(spawnSync('/usr/bin/xattr', ['-px', name, target], { encoding: 'utf8' }).stdout).toBe(
      value
    )
})
it('ignored source bytes never become untracked recovery files caught by git add', async () => {
  const s = await setup()
  const git = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: s.repo, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  git('init', '-b', 'main')
  writeFileSync(join(s.repo, '.gitignore'), '.env\n')
  writeFileSync(join(s.repo, '.env'), 'sample=before')
  await s.save('ignored', {
    ...s.params,
    path: '.env',
    expected_content_id: hash('sample=before'),
    text: 'sample=after',
  })
  git('add', '.')
  const staged = git('diff', '--cached', '--name-only')
  expect(staged).not.toContain('.abele-')
  expect(staged).not.toContain('.env')
  expect(readdirSync(s.repo).filter((p) => p.startsWith('.abele-'))).toEqual([])
})
it('0444 is refused cleanly without unlinking, truncating or creating a recovery intent', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  chmodSync(target, 0o444)
  const ino = statSync(target).ino
  await expect(s.save()).rejects.toThrow('file_not_writable')
  expect(readFileSync(target, 'utf8')).toBe('before')
  expect(statSync(target)).toMatchObject({ ino })
  expect(s.core.db.prepare('SELECT count(*) n FROM file_mutations').get()!.n).toBe(0)
  expect(readdirSync(s.repo)).toEqual(['sample.txt'])
})
it('recovery byte quota includes uncertain writes and evicts oldest copies', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  let first!: Receipt
  for (let i = 0; i < 18; i++) {
    const base = String(i).padEnd(1024 * 1024, 'x')
    writeFileSync(target, base)
    s.core.resources.mutations.fault = (p) => {
      if (p === 'after_write') writeFileSync(target, 'competing')
    }
    const receipt = (await s.save('quota-' + i, {
      ...s.params,
      expected_content_id: hash(base),
    })) as Receipt
    if (!i) first = receipt
    expect(receipt.state).toBe('outcome_unknown')
  }
  const rows = s.core.db
    .prepare('SELECT path,size FROM file_recovery_copies WHERE workspace_id=?')
    .all(s.params.workspace_id) as { path: string; size: number }[]
  const files = diskCopies(s)
  expect(files.reduce((n, path) => n + statSync(path).size, 0)).toBeLessThanOrEqual(
    16 * 1024 * 1024
  )
  expect(files.length).toBeLessThanOrEqual(32)
  expect(files.length).toBe(rows.length)
  expect(existsSync(recovery(s, first))).toBe(false)
  expect(readdirSync(s.repo)).toEqual(['sample.txt'])
})
it('refuses files beyond the read/recovery limit without allocating an unbounded copy', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt'),
    bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 120)
  writeFileSync(target, bytes)
  await expect(s.save()).rejects.toThrow('file_too_large')
  expect(statSync(target).size).toBe(bytes.length)
  expect(s.core.db.prepare('SELECT count(*) n FROM file_recovery_copies').get()!.n).toBe(0)
})
it('migration 9 refuses legacy recovery rows and names their paths without importing or deleting', async () => {
  const s = await setup(),
    oldPath = '.abele-11111111-1111-1111-1111-111111111111-predecessor',
    target = join(s.repo, oldPath)
  writeFileSync(target, 'legacy retained')
  const db = schema8(s)
  db.prepare(
    'INSERT INTO legacy_file_recoveries(workspace_id,path,content_id,fingerprint) VALUES(?,?,?,?)'
  ).run(s.params.workspace_id, oldPath, hash('legacy retained'), 'legacy')
  db.close()
  let candidate: NodeCore | undefined, error: unknown
  try {
    candidate = new NodeCore(join(s.dir, 'state'))
    cores.push(candidate)
  } catch (e) {
    error = e
  }
  expect(String(error)).toContain('manual inspection')
  expect(String(error)).toContain('legacy_file_recoveries')
  expect(String(error)).toContain(oldPath)
  expect(readFileSync(target, 'utf8')).toBe('legacy retained')
  const check = new DatabaseSync(join(s.dir, 'state', 'node.sqlite'))
  try {
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(8)
    expect(check.prepare('SELECT count(*) n FROM legacy_file_recoveries').get()!.n).toBe(1)
    expect(check.prepare('SELECT count(*) n FROM file_recovery_copies').get()!.n).toBe(0)
  } finally {
    check.close()
  }
})
it('migration 9 refuses old mutation intents without discarding their evidence', async () => {
  const s = await setup(),
    oldPath = '.abele-22222222-2222-2222-2222-222222222222-predecessor'
  writeFileSync(join(s.repo, oldPath), 'legacy bytes')
  const db = schema8(s),
    body = JSON.stringify({
      params: s.params,
      backup: oldPath,
      temporary: '.abele-sample-new',
      predecessor: hash('legacy bytes'),
    })
  db.prepare('INSERT INTO file_mutations VALUES(?,?,?,?)').run(
    s.actor.installation_id,
    'old-save',
    'old-hash',
    body
  )
  db.close()
  let error: unknown
  try {
    const c = new NodeCore(join(s.dir, 'state'))
    cores.push(c)
  } catch (e) {
    error = e
  }
  expect(String(error)).toContain('manual inspection')
  expect(String(error)).toContain('old-save')
  expect(String(error)).toContain(oldPath)
  expect(readFileSync(join(s.repo, oldPath), 'utf8')).toBe('legacy bytes')
  const check = new DatabaseSync(join(s.dir, 'state', 'node.sqlite'))
  try {
    expect(
      check.prepare('SELECT body FROM file_mutations WHERE operation_id=?').get('old-save')!.body
    ).toBe(body)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(8)
  } finally {
    check.close()
  }
})
it('migration 9 drops only an empty legacy table and preserves normal recovery rows', async () => {
  const s = await setup(),
    receipt = (await s.save()) as Receipt
  const db = schema8(s)
  db.close()
  const c = new NodeCore(join(s.dir, 'state'))
  cores.push(c)
  expect(c.db.prepare('PRAGMA user_version').get()!.user_version).toBe(12)
  expect(
    c.db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_file_recoveries'").get()
  ).toBeUndefined()
  expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
  expect(c.db.prepare('SELECT count(*) n FROM file_recovery_copies').get()!.n).toBe(1)
})
it('startup removes unregistered full/partial recovery files but keeps referenced copies', async () => {
  const s = await setup(),
    receipt = (await s.save()) as Receipt,
    directory = join(s.dir, 'state', 'file-recovery', s.params.workspace_id)
  writeFileSync(join(directory, 'orphan-full.bin'), Buffer.alloc(17 * 1024 * 1024))
  writeFileSync(join(directory, 'orphan-partial.bin'), 'partial')
  s.core.close()
  const c = new NodeCore(join(s.dir, 'state'))
  cores.push(c)
  expect(diskCopies(s)).toEqual([recovery(s, receipt)])
  expect(diskCopies(s).reduce((n, p) => n + statSync(p).size, 0)).toBeLessThanOrEqual(
    16 * 1024 * 1024
  )
  expect(readFileSync(recovery(s, receipt), 'utf8')).toBe('before')
})
it('new recovery directory entries are fsynced in each parent before the intent, once per creation', async () => {
  const s = await setup(),
    state = join(s.dir, 'state'),
    root = join(state, 'file-recovery'),
    workspace = join(root, s.params.workspace_id)
  const synced: number[] = [],
    original = fs.fsyncSync
  const spy = vi.mocked(fsyncSync).mockImplementation((fd) => {
    const stat = fs.fstatSync(fd)
    if (stat.isDirectory()) synced.push(stat.ino)
    return original(fd)
  })
  try {
    s.core.resources.mutations.fault = (p) => {
      if (p === 'after_intent') {
        expect(synced.filter((ino) => ino === statSync(state).ino)).toHaveLength(1)
        expect(synced.filter((ino) => ino === statSync(root).ino)).toHaveLength(1)
        expect(synced.filter((ino) => ino === statSync(workspace).ino)).toHaveLength(1)
      }
    }
    await s.save()
    s.core.resources.mutations.fault = undefined
    await s.save('second', { ...s.params, expected_content_id: hash('after'), text: 'next' })
    expect(synced.filter((ino) => ino === statSync(state).ino)).toHaveLength(1)
    expect(synced.filter((ino) => ino === statSync(root).ino)).toHaveLength(1)
  } finally {
    spy.mockRestore()
  }
})
it('creates new files exclusively and refuses a competing create without modifying it', async () => {
  const s = await setup(),
    params = { ...s.params, path: 'new.txt', expected_content_id: null }
  expect(await s.save('new', params)).toMatchObject({
    state: 'saved',
    predecessor_content_id: null,
    recovery_path: null,
  })
  expect(readFileSync(join(s.repo, 'new.txt'), 'utf8')).toBe('after')
  expect(await s.save('other-new', { ...params, text: 'competing' })).toMatchObject({
    state: 'conflict',
  })
  expect(readFileSync(join(s.repo, 'new.txt'), 'utf8')).toBe('after')
})
it('explicit recovery restore uses a fresh precondition and never retries the original write', async () => {
  const s = await setup(),
    target = join(s.repo, 'sample.txt')
  s.core.resources.mutations.fault = (p) => {
    if (p === 'after_truncate') throw new Error('crash')
  }
  await expect(s.save()).rejects.toThrow('crash')
  s.core.resources.mutations.fault = undefined
  const receipt = (await s.save()) as Receipt
  const params = {
    workspace_id: s.params.workspace_id,
    path: s.params.path,
    expected_content_id: hash(''),
    recovery_path: receipt.recovery_path,
  }
  expect(await s.core.request(s.actor, 'workspace.restore', params, 'restore')).toMatchObject({
    state: 'saved',
    content_id: hash('before'),
  })
  expect(readFileSync(target, 'utf8')).toBe('before')
  writeFileSync(target, 'later')
  expect(await s.core.request(s.actor, 'workspace.restore', params, 'restore')).toMatchObject({
    state: 'saved',
  })
  expect(readFileSync(target, 'utf8')).toBe('later')
})
it('lost committed response replays a receipt, not a filesystem effect', async () => {
  const s = await setup()
  s.core.fault = (p) => {
    if (p === 'after_commit') throw new Error('lost response')
  }
  await expect(s.save()).rejects.toThrow('lost response')
  s.core.fault = undefined
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('after')
  writeFileSync(join(s.repo, 'sample.txt'), 'external')
  expect(await s.save()).toMatchObject({ state: 'saved' })
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('external')
})
it('serializes concurrent API writes against the same version', async () => {
  const s = await setup()
  expect(
    await Promise.all([s.save('first'), s.save('second', { ...s.params, text: 'second' })])
  ).toMatchObject([{ state: 'saved' }, { state: 'conflict' }])
})
it('rejects symlinks, metadata, traversal, binary and excessive writes before mutation', async () => {
  const s = await setup()
  symlinkSync(join(s.repo, 'sample.txt'), join(s.repo, 'link'))
  for (const path of ['link', '../sample.txt', '.git/config'])
    await expect(s.save(path, { ...s.params, path })).rejects.toThrow()
  await expect(s.save('binary', { ...s.params, text: '\0' })).rejects.toThrow('invalid_params')
  await expect(s.save('huge', { ...s.params, text: 'x'.repeat(32769) })).rejects.toThrow(
    'invalid_params'
  )
  s.core.revokeToken(s.actor.installation_id)
  await expect(s.save()).rejects.toThrow('unauthorized')
  expect(readFileSync(join(s.repo, 'sample.txt'), 'utf8')).toBe('before')
})
