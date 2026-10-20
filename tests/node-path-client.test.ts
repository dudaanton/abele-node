import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { NodeClient, MemoryClientStore, NodePathClient } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
it('opens, watches, creates and initializes a folder over the existing channel with schema-validated results', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const parent = join(dir, 'parent')
  mkdirSync(parent)
  const state = join(dir, 'state')
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const client = new NodeClient(
    { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token: token.token },
    new MemoryClientStore()
  )
  cleanup.push(() => client.disconnect())
  await client.connect()
  const picker = await client.nodePath.directories({ path: parent })
  const folder = await client.nodePath.mkdir(
    { directory_id: picker.directory_id, name: 'folder' },
    'create-one'
  )
  const project = await client.nodePath.register(
    { path: folder.path, trust: 'untrusted', exact_root: true },
    'register-one'
  )
  const workspace = (await client.listWorkspaces(project.project_id))[0]!
  await client.subscribe('catalog')
  const lease = await client.nodePath.watch({ workspace_id: workspace.workspace_id })
  const cursor = await client.cursor('catalog')
  writeFileSync(join(folder.path, 'sample'), 'plain contents')
  await expect
    .poll(
      async () =>
        (await client.history('catalog')).some(
          (e) => e.seq > cursor && e.type === 'workspace.invalidated'
        ),
      { timeout: 5000 }
    )
    .toBe(true)
  await client.nodePath.unwatch({
    workspace_id: workspace.workspace_id,
    subscription_id: lease.subscription_id,
  })
  await client.nodePath.fileMkdir({ workspace_id: workspace.workspace_id, path: 'new-folder' })
  const createdFile = await client.writeFile({
    workspace_id: workspace.workspace_id,
    path: 'new-folder/new.txt',
    expected_content_id: null,
    text: 'created',
  })
  expect(await client.fileMutationResult(createdFile.operation_id)).toMatchObject({
    state: 'saved',
  })
  const manifest = await client.nodePath.fileDirectory({
    workspace_id: workspace.workspace_id,
    path: 'new-folder',
  })
  expect(manifest.entries.map((entry) => entry.path)).toEqual(['', 'new.txt'])
  expect(
    await client.nodePath.fileMove({
      workspace_id: workspace.workspace_id,
      from: 'new-folder',
      to: 'renamed-folder',
      directory: true,
      expected_content_id: manifest.content_id,
    })
  ).toMatchObject({ state: 'applied' })
  expect(
    await client.nodePath.fileRemove({
      workspace_id: workspace.workspace_id,
      path: 'renamed-folder',
      directory: true,
      expected_content_id: manifest.content_id,
    })
  ).toMatchObject({ state: 'applied' })
  const initialized = await client.nodePath.gitInit(
    { project_id: project.project_id, initial_branch: 'trunk' },
    'init-one'
  )
  expect(initialized.project_id).toBe(project.project_id)
  const root = (
    await client.repository.worktrees({ project_id: project.project_id, include_selection: true })
  ).entries[0]!
  expect(root).toMatchObject({ kind: 'root', listed: true, head: null })
  const working = await client.repository.observe({ worktree_id: root.worktree_id })
  const enriched = await client.repository.status({
    worktree_id: root.worktree_id,
    revision: working.revision,
    include_change_details: true,
  })
  expect(enriched.entries[0]).toMatchObject({
    kind: 'A',
    stage: 'unstaged',
    time_basis: 'observed',
  })
  expect(
    await client.nodePath.divergence({ worktree_id: root.worktree_id, base_ref: 'trunk' })
  ).toMatchObject({ reason: 'unborn_head', ahead: null, behind: null })
})
it('replays an offline guarded send and exports the typed refusal over the channel', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/send-target-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const state = join(dir, 'state')
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const endpoint = {
    url: `ws://127.0.0.1:${daemon.port}/channel`,
    profile: 'local-token-v1' as const,
    token: token.token,
  }
  const store = new MemoryClientStore()
  const client = new NodeClient(endpoint, store)
  cleanup.push(() => client.disconnect())
  await client.connect()
  const project = await client.registerProject(folder, 'trusted')
  const workspace = (await client.listWorkspaces(project.project_id))[0]!
  const target = { kind: 'workspace' as const, workspace_id: workspace.workspace_id }
  await client.nodePath.execution({ project_id: project.project_id, target, enabled: true })
  const chat = await client.nodePath.createSession({ provider: 'fake', target })
  const displayed = await client.nodePath.sessionWorktreeGet({
    session_id: chat.session_id,
    include_incarnation: true,
  })
  expect(displayed.incarnation).toEqual(expect.any(String))
  const expected = { target: displayed.target, incarnation: displayed.incarnation! }
  await client.disconnect()
  await client.send(chat.session_id, 'offline draft', 0, undefined, expected, 'offline-send')
  const owner = new NodeClient(endpoint, new MemoryClientStore())
  cleanup.push(() => owner.disconnect())
  await owner.connect()
  await owner.detachSession(chat.session_id)
  const reloaded = new NodeClient(endpoint, store)
  cleanup.push(() => reloaded.disconnect())
  await reloaded.connect()
  await reloaded.flush()
  expect(await reloaded.sendResult('offline-send')).toEqual({
    code: 'target_changed',
    current_target: null,
  })
  expect(await reloaded.pending()).toEqual([])
  await reloaded.send(chat.session_id, 'offline draft', 0, undefined, expected, 'offline-send')
  expect(await reloaded.sendResult('offline-send')).toEqual({
    code: 'target_changed',
    current_target: null,
  })
  await expect(
    reloaded.send(chat.session_id, 'offline draft', 0, undefined, undefined, 'offline-send')
  ).rejects.toThrow('idempotency_mismatch')
})
it('rejects malformed directory and divergence results rather than trusting UI-shaped fakes', async () => {
  const client = new NodePathClient(
    async () => ({ entries: [], extra: true }),
    async () => ({ path: '../unsafe' })
  )
  await expect(client.directories()).rejects.toThrow()
  await expect(client.mkdir({ directory_id: 'handle', name: 'child' })).rejects.toThrow()
  await expect(client.divergence({ worktree_id: 'target' })).rejects.toThrow()
})
it('awaits real file/worktree mutation receipts and does not confuse operation IDs with completion', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-mutation-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
    return p.stdout.trim()
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'sample'), 'contents')
  git('add', '.')
  git('commit', '-m', 'initial')
  const external = join(dir, 'external')
  git('worktree', 'add', '-b', 'side', external)
  const state = join(dir, 'state'),
    token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as { token: string }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const client = new NodeClient(
    { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token: token.token },
    new MemoryClientStore()
  )
  cleanup.push(() => client.disconnect())
  await client.connect()
  const project = await client.nodePath.register({
    path: folder,
    trust: 'untrusted',
    exact_root: true,
  })
  const root = (await client.repository.worktrees({ project_id: project.project_id })).entries[0]!
  const expected_content_id = createHash('sha256').update('contents').digest('hex')
  const copied = await client.nodePath.fileCopy(
    { worktree_id: root.worktree_id, from: 'sample', to: 'copy', expected_content_id },
    'client-copy'
  )
  expect(copied).toMatchObject({ operation_id: 'client-copy', state: 'applied' })
  expect(existsSync(join(folder, 'copy'))).toBe(true)
  expect(
    (
      await client.nodePath.fileMove({
        worktree_id: root.worktree_id,
        from: 'copy',
        to: 'moved',
        expected_content_id,
      })
    ).state
  ).toBe('applied')
  expect(
    (
      await client.nodePath.fileRemove({
        worktree_id: root.worktree_id,
        path: 'moved',
        expected_content_id,
      })
    ).state
  ).toBe('applied')
  expect(
    (await client.nodePath.fileMkdir({ worktree_id: root.worktree_id, path: 'child' })).state
  ).toBe('applied')
  const directory = await client.nodePath.fileDirectory({
    worktree_id: root.worktree_id,
    path: 'child',
  })
  expect(directory.entries).toEqual([{ path: '', kind: 'directory', content_id: null }])
  expect(
    await client.nodePath.fileMove({
      worktree_id: root.worktree_id,
      from: 'child',
      to: 'renamed',
      directory: true,
      expected_content_id: directory.content_id,
    })
  ).toMatchObject({ state: 'applied' })
  expect(
    await client.nodePath.fileRemove({
      worktree_id: root.worktree_id,
      path: 'renamed',
      directory: true,
      expected_content_id: directory.content_id,
    })
  ).toMatchObject({ state: 'applied' })
  await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const target = (
    await client.repository.worktrees({ project_id: project.project_id })
  ).entries.find((e) => e.kind === 'external')!
  const observed = await client.repository.observe({ worktree_id: target.worktree_id })
  if (observed.revision.kind !== 'working') throw new Error('working revision required')
  const params = {
    worktree_id: target.worktree_id,
    expected_head: observed.revision.head,
    expected_observation_id: observed.revision.observation_id,
  }
  expect(await client.nodePath.deleteWorktree(params, 'client-delete')).toEqual({
    worktree_id: target.worktree_id,
    state: 'deleted',
  })
  expect(await client.nodePath.deleteWorktree(params, 'client-delete')).toEqual({
    worktree_id: target.worktree_id,
    state: 'deleted',
  })
})
it('creates target-bound fake chats and replays one owner switch event over the existing channel', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-chat-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'sample'), 'contents')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('worktree', 'add', '-b', 'side', join(dir, 'external'))
  const state = join(dir, 'state'),
    token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as { token: string }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const client = new NodeClient(
    { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token: token.token },
    new MemoryClientStore()
  )
  cleanup.push(() => client.disconnect())
  await client.connect()
  const project = await client.nodePath.register({
    path: folder,
    trust: 'untrusted',
    exact_root: true,
  })
  await client.nodePath.trust({ project_id: project.project_id, trust: 'trusted' })
  await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const entries = (await client.repository.worktrees({ project_id: project.project_id })).entries
  const root = { kind: 'worktree' as const, worktree_id: entries[0]!.worktree_id }
  const external = {
    kind: 'worktree' as const,
    worktree_id: entries.find((e) => e.kind === 'external')!.worktree_id,
  }
  for (const target of [root, external])
    await client.nodePath.execution({ project_id: project.project_id, target, enabled: true })
  const chat = await client.nodePath.createSession({ provider: 'fake', target: root })
  await client.subscribe(chat.session_id)
  await client.subscribe('catalog')
  await client.send(chat.session_id, 'fixture turn', await client.cursor(chat.session_id))
  await expect
    .poll(
      async () => (await client.history(chat.session_id)).some((e) => e.type === 'run.completed'),
      { timeout: 5000 }
    )
    .toBe(true)
  const params = { session_id: chat.session_id, expected_target: root, target: external }
  expect(await client.nodePath.sessionWorktreeSet(params, 'client-switch')).toEqual({
    session_id: chat.session_id,
    target: external,
  })
  expect(await client.nodePath.sessionWorktreeSet(params, 'client-switch')).toEqual({
    session_id: chat.session_id,
    target: external,
  })
  expect(await client.nodePath.sessionWorktreeGet({ session_id: chat.session_id })).toEqual({
    project_id: project.project_id,
    target: external,
  })
  await expect
    .poll(
      async () =>
        (await client.history(chat.session_id)).filter((e) => e.type === 'session.worktree.changed')
          .length
    )
    .toBe(1)
})
