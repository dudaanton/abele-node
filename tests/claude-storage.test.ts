import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeCore, ClaudeProviderAdapter } from '@abele/node-core'
it('releases pre-spawn worker ownership even when a dispatch journal transaction fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-claude-storage-')),
    repo = join(dir, 'repo'),
    executable = join(dir, 'claude.mjs')
  mkdirSync(repo)
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
  ])
    expect(spawnSync('/usr/bin/git', args, { cwd: repo }).status).toBe(0)
  writeFileSync(join(repo, 'file'), 'original')
  for (const args of [
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ])
    expect(spawnSync('/usr/bin/git', args, { cwd: repo }).status).toBe(0)
  cpSync(resolve('tests/fixtures/claude.mjs'), executable)
  chmodSync(executable, 0o700)
  const core = new NodeCore(join(dir, 'state'), {
    claude: new ClaudeProviderAdapter({ executable }),
  })
  const actor = core.authority.authenticate(core.createToken('test').token)
  try {
    const project = (await core.request(
      actor,
      'project.register',
      { path: repo, trust: 'trusted' },
      'project'
    )) as { project_id: string }
    const job = (await core.request(
      actor,
      'workspace.create',
      { project_id: project.project_id },
      'workspace'
    )) as { workspace_id: string }
    await core.resources.jobs.drain()
    const session = core.request(
      actor,
      'session.create',
      { title: 'Claude', provider: 'claude', workspace_id: job.workspace_id },
      'session'
    ) as { session_id: string }
    core.request(
      actor,
      'session.send',
      { session_id: session.session_id, text: 'allow', observed_seq: 0 },
      'input'
    )
    const append = core.append.bind(core)
    core.append = (...args) => {
      if (args[1] === 'run.started') throw new Error('injected journal failure')
      return append(...args)
    }
    await expect(core.claude.drain()).rejects.toThrow(/storage_unavailable/)
    const stopped = await Promise.race([
      core.claude.stop().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ])
    expect(stopped).toBe(true)
    expect(core.db.prepare('SELECT count(*) AS n FROM provider_runs').get()).toMatchObject({ n: 0 })
    expect(core.db.prepare('SELECT state FROM inputs').get()).toMatchObject({ state: 'queued' })
  } finally {
    // Test teardown must also release a deliberately broken pre-fix reservation after asserting.
    ;(core.claude as unknown as { active: Map<string, unknown> }).active.clear()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
