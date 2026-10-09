import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { startDaemon, offlineToken } from '@abele/node-daemon'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    await delay(25)
  }
  throw Error('delegation acceptance deadline')
}
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
for (const provider of ['claude', 'pi'] as const)
  it(`accepts delegation to fake ${provider}, finishes offline, and replays exactly one result after client and daemon restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-daemon-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const repo = join(dir, 'repo'),
      state = join(dir, 'state')
    mkdirSync(repo)
    const git = (...args: string[]) => {
      const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
    }
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'file.txt'), 'fixture')
    git('add', '.')
    git('commit', '-m', 'fixture')
    const token = (await offlineToken(state, { action: 'create', value: 'parent' })) as {
      token: string
    }
    const otherToken = (await offlineToken(state, { action: 'create', value: 'human' })) as {
      token: string
    }
    let daemon = await startDaemon(
      state,
      0,
      undefined,
      { deadlineMs: 15000 },
      undefined,
      undefined,
      { profile: 'isolated', deadlineMs: 15000 }
    )
    cleanup.push(() => daemon.stop())
    const store = new MemoryClientStore()
    const make = (auth = token, storage = store) =>
      new NodeClient(
        {
          url: `ws://127.0.0.1:${daemon.port}/channel`,
          profile: 'local-token-v1',
          token: auth.token,
        },
        storage
      )
    let parent = make()
    cleanup.push(() => parent.disconnect())
    await parent.connect()
    const project = await parent.registerProject(repo, 'trusted')
    const grant = await parent.approveDelegationGrant({
      parent_id: 'plugin-chat',
      project_ids: [project.project_id],
      providers: [provider],
    })
    const params = {
      grant_id: grant.grant_id,
      delegation_key: 'stable-task-key',
      title: 'worker',
      project_id: project.project_id,
      provider,
      text: 'delegation-report',
    }
    const child = await parent.createDelegation(params)
    await parent.subscribeDelegation(child)
    await parent.disconnect()
    // A human can open the full child independently, but cannot read the parent's mailbox.
    const human = make(otherToken, new MemoryClientStore())
    cleanup.push(() => human.disconnect())
    await human.connect()
    await human.subscribe(child.session_id)
    await expect(human.subscribe(child.mailbox_stream_id)).rejects.toThrow(/unauthorized/)
    await until(async () =>
      (await human.history(child.session_id)).some((e) => e.type === 'run.completed')
    )
    expect((await human.getSession(child.session_id)).provider).toBe(provider)
    const workspace = await human.getWorkspace(child.workspace_id!)
    expect(workspace.state).toBe('ready')
    await human.disconnect()
    await daemon.stop()
    daemon = await startDaemon(state, 0, undefined, { deadlineMs: 15000 }, undefined, undefined, {
      profile: 'isolated',
      deadlineMs: 15000,
    })
    parent = make()
    await parent.connect()
    await until(async () =>
      (await parent.history(child.mailbox_stream_id)).some((e) => e.type === 'delegation.result')
    )
    expect(await parent.createDelegation(params)).toEqual(child)
    const status = await parent.delegationStatus(child.delegation_id)
    expect(status.state).toBe('completed')
    const mailbox = await parent.history(child.mailbox_stream_id)
    expect(mailbox.filter((e) => e.type === 'delegation.result')).toHaveLength(1)
    expect(mailbox.find((e) => e.type === 'delegation.result')!.data).toHaveProperty(
      'text',
      'Structured final answer'
    )
    expect(mailbox.filter((e) => e.type === 'delegation.progress')).toHaveLength(1)
    expect(mailbox.filter((e) => e.type === 'delegation.question')).toHaveLength(1)
    expect(mailbox.filter((e) => e.type === 'delegation.terminal')).toHaveLength(1)
    expect(mailbox.some((e) => e.type.includes('tool.'))).toBe(false)
    await parent.disconnect()
    await parent.connect()
    await delay(80)
    expect(
      (await parent.history(child.mailbox_stream_id)).filter((e) => e.type === 'delegation.result')
    ).toHaveLength(1)
    if (provider === 'claude')
      expect(
        readFileSync(join(workspace.path, 'invocations.jsonl'), 'utf8').trim().split('\n')
      ).toHaveLength(1)
    else expect((await parent.getSession(child.session_id)).native_session_file).toBeTruthy()
  })
