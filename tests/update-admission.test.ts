import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NodeCore, type ProviderAdapter } from '@abele/node-core'

it.each(['before drain', 'during workspace validation'])(
  'does not start queued runs when an updater locks admission %s, and resumes afterward',
  async (timing) => {
    mkdirSync('.scratch', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/update-admission-')),
      repo = join(dir, 'repo'),
      state = join(dir, 'state')
    mkdirSync(repo)
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'file'), 'test')
    git('add', '.')
    git('commit', '-m', 'fixture')
    const adapter: ProviderAdapter = {
      available: true,
      configuration: { permission_ttl_ms: 10000 },
      configurationForTurn: () => ({}),
      capabilities: () => ({ provider: 'pi', available: true }),
      reconcile: async () => {},
      startTurn: vi.fn(async () => ({
        done: Promise.resolve({ reason: 'test completed' }),
        interrupt: async () => {},
      })),
    }
    const core = new NodeCore(state, { pi: adapter })
    const actor = core.authority.authenticate(core.createToken('test').token)
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
        title: 'test',
        provider: 'pi',
        workspace_id: workspace.workspace_id,
      }) as { session_id: string }
      request('session.send', { session_id: session.session_id, text: 'test', observed_seq: 0 })
      const lock = join(state, 'update.lock')
      const pause = () => writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
      if (timing === 'before drain') pause()
      else {
        const bound = core.resources.workspaces.bound.bind(core.resources.workspaces)
        vi.spyOn(core.resources.workspaces, 'bound').mockImplementation(async (...args) => {
          const result = await bound(...args)
          pause() // admission changes across the asynchronous filesystem boundary
          return result
        })
      }
      await core.execution.drain()
      expect(adapter.startTurn).not.toHaveBeenCalled()
      expect(core.db.prepare('SELECT * FROM provider_runs').all()).toEqual([])
      vi.restoreAllMocks()
      rmSync(lock)
      await core.execution.drain()
      expect(adapter.startTurn).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
