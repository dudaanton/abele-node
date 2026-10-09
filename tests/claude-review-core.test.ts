import { expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore, ClaudeProviderAdapter } from '@abele/node-core'
import {
  systemProcessProbe,
  ProcessSupervisor,
  type ProcessIdentity,
  type ClaudeOptions,
} from '@abele/provider-claude'
const until = (test: () => boolean) => waitForProcessCondition(test, 'Claude durable evidence')
async function setup(options: ClaudeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-review-')),
    repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'file'), 'original')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const adapter = new ClaudeProviderAdapter({
      executable: process.env.ABELE_CLAUDE_PATH,
      ...options,
    }),
    core = new NodeCore(join(dir, 'state'), { claude: adapter }),
    actor = core.authority.authenticate(core.createToken('test').token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID())
  const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
    project_id: string
  }
  const job = (await request('workspace.create', { project_id: project.project_id })) as {
    workspace_id: string
  }
  await core.resources.jobs.drain()
  const session = request('session.create', {
    title: 'Review',
    provider: 'claude',
    workspace_id: job.workspace_id,
  }) as { session_id: string }
  return {
    dir,
    repo,
    core,
    adapter,
    actor,
    request,
    project,
    workspace_id: job.workspace_id,
    session_id: session.session_id,
    cleanup: async () => {
      await core.claude.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
it('unknown cleanup evidence leaves a durable active run, unknown input and a non-detachable workspace', async () => {
  let unavailable = true
  const s = await setup({
    processProbe: {
      identity: (pid) => {
        if (unavailable) throw Error('process_probe_unavailable')
        return systemProcessProbe.identity(pid)
      },
      groupMembers: (leader) => {
        if (unavailable) throw Error('process_probe_unavailable')
        return systemProcessProbe.groupMembers(leader)
      },
    },
  })
  try {
    s.request('session.send', { session_id: s.session_id, text: 'echo', observed_seq: 0 })
    await s.core.claude.drain()
    await until(
      () => !!s.core.db.prepare("SELECT 1 FROM inputs WHERE state='delivery_unknown'").get()
    )
    expect(s.core.db.prepare('SELECT state FROM provider_runs').get()).toMatchObject({
      state: 'active',
    })
    expect(() => s.request('session.detach', { session_id: s.session_id })).toThrow(/resource_busy/)
    await expect(s.core.claude.reconcile()).rejects.toThrow(/process_probe_unavailable/)
    await expect(s.core.claude.stop()).rejects.toThrow(/process_cleanup_unconfirmed/)
  } finally {
    unavailable = false
    await s.cleanup()
  }
})
it('core retains an unconfirmed stopped worker so stop fails while the probe fails, then retries and kills the whole group', async () => {
  let unavailable = false
  const s = await setup({
    processProbe: {
      identity: (pid) => {
        if (unavailable) throw Error('process_probe_unavailable')
        return systemProcessProbe.identity(pid)
      },
      groupMembers: (leader) => {
        if (unavailable) throw Error('process_probe_unavailable')
        return systemProcessProbe.groupMembers(leader)
      },
    },
  })
  let evidence: ProcessIdentity[] = []
  try {
    s.request('session.send', { session_id: s.session_id, text: 'hang', observed_seq: 0 })
    await s.core.claude.drain()
    const workspace = s.core.resources.workspaces.get(s.workspace_id)
    await until(() => existsSync(join(workspace.path, 'descendant.pid')))
    const child = Number(readFileSync(join(workspace.path, 'descendant.pid'), 'utf8'))
    const row = s.core.db.prepare('SELECT run_id,processes FROM provider_runs').get() as {
      run_id: string
      processes: string
    }
    evidence = JSON.parse(row.processes)
    const worker = evidence[0]!
    process.kill(worker.pid, 'SIGSTOP')
    unavailable = true
    s.request('session.interrupt', { session_id: s.session_id, run_id: row.run_id })
    await expect(s.core.claude.drain()).rejects.toThrow(/process_cleanup_unconfirmed/)
    await expect(s.core.claude.stop()).rejects.toThrow(/process_cleanup_unconfirmed/)
    expect(systemProcessProbe.identity(worker.pid)).toBeDefined()
    expect(systemProcessProbe.identity(child)).toBeDefined()
    expect(s.core.db.prepare('SELECT state FROM provider_runs').get()).toMatchObject({
      state: 'active',
    })
    expect(() => s.request('session.detach', { session_id: s.session_id })).toThrow(/resource_busy/)
    unavailable = false
    await s.core.claude.stop()
    expect(systemProcessProbe.identity(worker.pid)).toBeUndefined()
    expect(systemProcessProbe.identity(child)).toBeUndefined()
    expect(s.core.db.prepare('SELECT state FROM provider_runs').get()).toMatchObject({
      state: 'settled',
    })
    expect(s.core.db.prepare('SELECT state FROM inputs').get()).toMatchObject({
      state: 'delivery_unknown',
    })
    expect(() => s.request('session.detach', { session_id: s.session_id })).not.toThrow()
  } finally {
    unavailable = false
    await ProcessSupervisor.cleanup(evidence)
    await s.cleanup()
  }
}, 8)
it('repository permission opt-in is explicit, durable, idempotent and journaled on the project', async () => {
  const s = await setup()
  try {
    expect(
      s.core.resources.projects.get(s.project.project_id).use_repository_claude_permissions
    ).toBe(false)
    const params = { project_id: s.project.project_id, use_repository_permissions: true },
      operation = 'opt-in'
    const result = await s.core.request(s.actor, 'project.claude_permissions', params, operation)
    expect(result).toMatchObject({ use_repository_claude_permissions: true })
    expect(await s.core.request(s.actor, 'project.claude_permissions', params, operation)).toEqual(
      result
    )
    expect(
      s.core.read('catalog', 0).filter((e) => e.type === 'project.claude_permissions.changed')
    ).toHaveLength(1)
    const body = s.core.db
      .prepare('SELECT body FROM projects WHERE project_id=?')
      .get(s.project.project_id) as { body: string }
    expect(JSON.parse(body.body).use_repository_claude_permissions).toBe(true)
    await s.request('project.claude_permissions', {
      project_id: s.project.project_id,
      use_repository_permissions: false,
    })
    expect(
      s.core.resources.projects.get(s.project.project_id).use_repository_claude_permissions
    ).toBe(false)
  } finally {
    await s.cleanup()
  }
})
it('prompt delivery is atomically reserved and consumed once, including callbacks invoked twice', async () => {
  const s = await setup()
  try {
    const input = {
      input_id: 'input',
      session_id: s.session_id,
      run_id: 'run',
      principal_id: s.actor.installation_id,
    }
    s.core.db
      .prepare(
        'INSERT INTO inputs(input_id,session_id,principal_id,state,body,run_id) VALUES(?,?,?,?,?,?)'
      )
      .run('input', s.session_id, s.actor.installation_id, 'delivered', '{}', 'run')
    const service = s.core.claude as unknown as {
      permission(
        record: typeof input,
        action: { tool_use_id: string; tool_name: string; input: Record<string, unknown> },
        signal: AbortSignal
      ): Promise<{ choice: string; delivered(): boolean }>
    }
    const action = { tool_use_id: 'call', tool_name: 'Bash', input: { command: 'one action' } },
      signal = new AbortController().signal
    const first = service.permission(input, action, signal),
      second = service.permission(input, action, signal)
    const prompt = s.core.prompts(s.session_id)[0]!
    s.request('prompt.answer', {
      session_id: s.session_id,
      prompt_id: prompt.prompt_id,
      run_id: 'run',
      revision: 1,
      action_digest: prompt.action_digest,
      choice: 'allow',
    })
    const [a, b] = await Promise.all([first, second])
    expect([a.choice, b.choice].sort()).toEqual(['allow', 'deny'])
    const grant = a.choice === 'allow' ? a : b,
      rejected = a.choice === 'deny' ? a : b
    expect(grant.delivered()).toBe(true)
    expect(grant.delivered()).toBe(false)
    expect(rejected.delivered()).toBe(false)
    expect((await service.permission(input, action, signal)).choice).toBe('deny')
    expect(s.core.read(s.session_id, 0).filter((e) => e.type === 'prompt.delivered')).toHaveLength(
      1
    )
  } finally {
    await s.cleanup()
  }
})
