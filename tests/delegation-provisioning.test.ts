import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeCore } from '@abele/node-core'
it('reserves one workspace/job/child under concurrent retries and queues followups behind provisioning without executing early', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-provision-')),
    repo = join(dir, 'repo')
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
  let core = new NodeCore(join(dir, 'state'))
  try {
    const actor = core.authority.authenticate(core.createToken('parent').token)
    const request = (method: string, p: unknown, op: string = crypto.randomUUID()) =>
      core.request(actor, method, p, op) as any
    const project = await request('project.register', { path: repo, trust: 'trusted' })
    const grant = request('delegation.grant.create', {
      parent_id: 'parent',
      project_ids: [project.project_id],
      allow_fake: true,
    })
    const params = {
      grant_id: grant.grant_id,
      delegation_key: 'concurrent',
      project_id: project.project_id,
      title: 'task',
      provider: 'fake',
      text: 'initial',
    }
    const [child, retry] = await Promise.all([
      request('delegation.create', params),
      request('delegation.create', params),
    ])
    expect(retry).toEqual(child)
    expect(child.state).toBe('provisioning')
    const sent = request(
      'delegation.send',
      { delegation_id: child.delegation_id, text: 'followup', observed_seq: 0 },
      'followup'
    )
    expect(sent.input_id).toBeTruthy()
    expect(
      (
        core.db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE json_extract(body,'$.kind')='workspace.create'"
          )
          .get() as any
      ).n
    ).toBe(1)
    core.tick()
    expect(core.read(child.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
    expect(() => request('session.detach', { session_id: child.session_id })).toThrow(
      /resource_busy/
    )
    core.close()
    core = new NodeCore(join(dir, 'state'))
    await core.resources.jobs.drain()
    core.tick()
    core.tick()
    expect(request('delegation.status', { delegation_id: child.delegation_id }).state).toBe(
      'completed'
    )
    expect(
      core
        .read(child.session_id, 0)
        .filter((e) => e.type === 'content.delta')
        .map((e) => (e.data as any).text)
    ).toEqual(['initial', 'followup'])
    expect(core.resources.workspaces.leased(child.workspace_id)).toBe(true)
    expect(
      core.read(child.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.result')
    ).toHaveLength(1)
    const failed = await request('delegation.create', {
      ...params,
      delegation_key: 'failed-provision',
    })
    const failedWorkspace = core.resources.workspaces.get(failed.workspace_id)
    // An unmanaged occupant is retained, and provisioning must fail without starting the child.
    mkdirSync(failedWorkspace.path)
    writeFileSync(join(failedWorkspace.path, 'valuable.txt'), 'retain')
    await core.resources.jobs.drain()
    core.tick()
    expect(request('delegation.status', { delegation_id: failed.delegation_id }).state).toBe(
      'failed'
    )
    expect(core.read(failed.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
    expect(
      (core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(failed.session_id) as any)
        .state
    ).toBe('failed')
    expect(
      core.read(failed.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.terminal')
    ).toHaveLength(1)
  } finally {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
