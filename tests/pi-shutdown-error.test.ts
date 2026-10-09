import { expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore } from '@abele/node-core'
import { PiProviderAdapter } from '@abele/provider-pi'
it('fails the durable turn after a successful prompt when SDK dispose swallows a session_shutdown error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-shutdown-')),
    repo = join(dir, 'repo'),
    stateDir = join(dir, 'state')
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
  const adapter = new PiProviderAdapter({
    stateDir,
    hostModule: resolve('tests/fixtures/pi-shutdown-host.mjs'),
    profile: 'isolated',
    deadlineMs: 10000,
  })
  const core = new NodeCore(stateDir, { pi: adapter }),
    actor = core.authority.authenticate(core.createToken('test').token)
  const request = (method: string, params: unknown) =>
    core.request(actor, method, params, randomUUID())
  try {
    const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
      project_id: string
    }
    const workspace = (await request('workspace.create', { project_id: project.project_id })) as {
      workspace_id: string
    }
    await core.resources.jobs.drain()
    const session = request('session.create', {
      title: 'shutdown',
      provider: 'pi',
      workspace_id: workspace.workspace_id,
    }) as { session_id: string }
    const input = request('session.send', {
      session_id: session.session_id,
      text: 'successful fake prompt',
      observed_seq: 0,
    }) as { input_id: string }
    await core.execution.drain()
    await waitForProcessCondition(() => {
      const row = core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(input.input_id)!
      return ['completed', 'failed', 'delivery_unknown'].includes(String(row.state))
    }, 'shutdown terminal evidence')
    expect(
      core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(input.input_id)
    ).toMatchObject({ state: 'failed' })
    const events = core.read(session.session_id, 0)
    expect(events.find((e) => e.type === 'run.failed')?.data).toHaveProperty(
      'reason',
      'extension_error'
    )
    expect(events.some((e) => e.type === 'run.completed')).toBe(false)
    const order = events.map((e) => e.type)
    expect(order.indexOf('pi.agent_settled')).toBeLessThan(order.indexOf('pi.extension.error'))
    expect(order.indexOf('pi.extension.error')).toBeLessThan(order.indexOf('run.failed'))
    expect(JSON.stringify(events)).not.toContain('FAKE_SHUTDOWN_SECRET')
  } finally {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
