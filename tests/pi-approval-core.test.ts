import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore, type ProviderAdapter } from '@abele/node-core'
import type { Answer } from '@abele/provider-pi'
it.each(['revoked', 'interrupted'])(
  'fails closed after %s at the durable provider-delivery boundary without treating stale control as disk failure',
  async (condition) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-approval-')),
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
    let answer!: Promise<Answer>, complete!: (r: any) => void
    const abort = new AbortController()
    const adapter: ProviderAdapter = {
      available: true,
      configuration: { permission_ttl_ms: 10000 },
      configurationForTurn: () => ({}),
      capabilities: () => ({ provider: 'pi', available: true }),
      reconcile: async () => {},
      startTurn: async (_turn, sink) => {
        sink.event({
          type: 'pi.native.child',
          data: { run_id: 'provider-native-run', child_id: 'native-child' },
        })
        answer = sink.permission(
          { tool_use_id: 'exact-call', tool_name: 'bash', input: { command: 'printf harmless' } },
          abort.signal
        )
        return {
          done: new Promise((r) => (complete = r)),
          interrupt: async () => {
            abort.abort()
            await answer.catch(() => {})
            complete({ reason: 'interrupted' })
          },
        }
      },
    }
    const core = new NodeCore(join(dir, 'state'), { pi: adapter }),
      token = core.createToken('requester'),
      actor = core.authority.authenticate(token.token)
    const request = (method: string, params: unknown) =>
      core.request(actor, method, params, randomUUID())
    try {
      const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
        project_id: string
      }
      const job = (await request('workspace.create', { project_id: project.project_id })) as {
        workspace_id: string
      }
      await core.resources.jobs.drain()
      const session = request('session.create', {
        title: 'pi',
        provider: 'pi',
        workspace_id: job.workspace_id,
      }) as { session_id: string }
      request('session.send', { session_id: session.session_id, text: 'hello', observed_seq: 0 })
      await core.execution.drain()
      const prompt = core.prompts(session.session_id)[0]!
      const native = core.read(session.session_id, 0).find((e) => e.type === 'pi.native.child')!
      expect(native.data).toMatchObject({
        run_id: prompt.run_id,
        provider_run_id: 'provider-native-run',
      })
      request('prompt.answer', {
        session_id: prompt.session_id,
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        revision: prompt.revision,
        action_digest: prompt.action_digest,
        choice: 'allow',
      })
      const resolved = await answer
      if (condition === 'revoked') {
        core.revokeToken(token.installation_id)
        expect(() => resolved.delivered()).toThrow(/unauthorized/)
      } else {
        request('session.interrupt', { session_id: session.session_id, run_id: prompt.run_id })
        expect(resolved.delivered()).toBe(false)
        expect(() =>
          request('session.create', { title: 'storage still healthy', provider: 'fake' })
        ).not.toThrow()
      }
      expect(core.prompt(prompt.prompt_id).delivered).toBe(false)
    } finally {
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
