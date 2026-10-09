import { expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { startDaemon, offlineToken } from '@abele/node-daemon'
const until = <T>(fn: () => T | Promise<T>) => waitForProcessCondition(fn, 'Pi daemon phase')
it('uses the existing client flow for allow/deny/expiry, extension answers, queue, replacement, crash and exact-file restart resume alongside fake Claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-daemon-')),
    state = join(dir, 'state'),
    repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(p.status, p.stderr).toBe(0)
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'tracked.txt'), 'original')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const auth = (await offlineToken(state, { action: 'create', value: 'test' })) as { token: string }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  let client: NodeClient | undefined
  const store = new MemoryClientStore()
  const start = async () => {
    daemon = await startDaemon(
      state,
      0,
      undefined,
      { permissionTtlMs: 600, deadlineMs: 15000 },
      undefined,
      undefined,
      { profile: 'isolated', permissionTtlMs: 600, deadlineMs: 15000 }
    )
    client = new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        profile: 'local-token-v1',
        token: auth.token,
        expected_node_id: daemon.node_id,
      },
      store
    )
    await client.connect()
  }
  try {
    await start()
    const c = () => client!
    const project = await c().registerProject(repo, 'trusted')
    const reserve = await c().createWorkspace(project.project_id)
    await until(async () => (await c().getJob(reserve.job_id)).state === 'succeeded')
    const workspace = await c().getWorkspace(reserve.workspace_id)
    const session = await c().createSession('pi', workspace.workspace_id, 'pi')
    const otherWorkspace = await c().createWorkspace(project.project_id)
    await until(async () => (await c().getJob(otherWorkspace.job_id)).state === 'succeeded')
    const claude = await c().createSession(
      'fake CLI alongside pi',
      otherWorkspace.workspace_id,
      'claude'
    )
    const s = session.session_id
    await c().subscribe(s)
    await c().subscribe(claude.session_id)
    expect((await c().describe()) as any).toHaveProperty('providers')
    const send = async (text: string) => {
      const op = await c().send(s, text, await c().cursor(s))
      return ((await c().operationResult(op.operation_id))!.result as { input_id: string }).input_id
    }
    const completed = (input: string, outcome = 'completed') =>
      until(async () =>
        (await c().history(s)).find(
          (e) => e.type === 'input.' + outcome && (e.data as any).input_id === input
        )
      )
    const pending = () => until(async () => (await c().prompts(s, undefined, 'pending'))[0])
    const allow = await send('allow'),
      follow = await send('echo')
    await c().send(claude.session_id, 'echo', await c().cursor(claude.session_id))
    await c().answerPrompt(await pending(), 'allow')
    await completed(allow)
    await completed(follow)
    await until(async () =>
      (await c().history(claude.session_id)).some((e) => e.type === 'run.completed')
    )
    expect(readFileSync(join(workspace.path, 'pi-allowed.txt'), 'utf8')).toBe('approved')
    const original = await c().getSession(s)
    expect(original.native_session_file).toBeTruthy()
    expect(existsSync(original.native_session_file!)).toBe(true)
    const deny = await send('deny')
    await c().answerPrompt(await pending(), 'deny')
    await completed(deny)
    expect(existsSync(join(workspace.path, 'pi-denied.txt'))).toBe(false)
    const expire = await send('expiry')
    const expired = await pending()
    await completed(expire)
    expect((await c().prompts(s)).find((p) => p.prompt_id === expired.prompt_id)?.state).toBe(
      'expired'
    )
    expect(existsSync(join(workspace.path, 'pi-expired.txt'))).toBe(false)
    const ui = await send('ui')
    const select = await pending()
    expect(select.kind).toBe('select')
    await expect(c().answerPrompt(select, 'allow', 'not-an-option')).rejects.toThrow(
      /invalid_params/
    )
    await c().answerPrompt(select, 'allow', 'B')
    const confirm = await pending()
    expect(confirm.kind).toBe('confirm')
    await c().answerPrompt(confirm, 'deny')
    const input = await pending()
    expect(input.kind).toBe('input')
    await c().answerPrompt(input, 'allow', 'hello')
    const trust = await pending()
    expect(trust.kind).toBe('trust')
    await c().answerPrompt(trust, 'deny')
    await completed(ui)
    const answers = JSON.parse(readFileSync(join(workspace.path, 'pi-ui.json'), 'utf8'))
    expect(answers).toEqual({ select: 'B', confirm: false, input: 'hello', trust: false })
    const commandError = await send('/unsupported')
    await completed(commandError, 'failed')
    const failedCommand = (await c().history(s)).find(
      (e) => e.type === 'input.failed' && (e.data as any).input_id === commandError
    )!
    expect(
      (await c().history(s)).find(
        (e) =>
          e.type === 'run.failed' && (e.data as any).run_id === (failedCommand.data as any).run_id
      )?.data
    ).toHaveProperty('reason', 'extension_error')
    const retry = await send('retry')
    await completed(retry)
    const events = await c().history(s)
    const run = (
      events.find((e) => e.type === 'input.completed' && (e.data as any).input_id === retry)!
        .data as any
    ).run_id
    expect(events.filter((e) => (e.data as any).run_id === run).map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'pi.agent_end',
        'pi.auto_retry_start',
        'pi.compaction_end',
        'pi.agent_settled',
        'run.completed',
      ])
    )
    const replacement = await send('replacegrants')
    const oldGrant = await pending()
    await c().answerPrompt(oldGrant, 'allow')
    const replacementGrant = await pending()
    expect(replacementGrant.native_session_id).not.toBe(oldGrant.native_session_id)
    expect(replacementGrant.action_digest).not.toBe(oldGrant.action_digest)
    await c().answerPrompt(replacementGrant, 'deny')
    await completed(replacement)
    const replaced = await c().getSession(s)
    expect(replaced.native_session_id).not.toBe(original.native_session_id)
    expect(JSON.stringify(await c().history(s))).not.toContain('STALE_SECRET')
    const parallel = await send('parallel')
    await c().answerPrompt(await pending(), 'allow')
    await c().answerPrompt(await pending(), 'allow')
    await completed(parallel)
    const parallelCalls = (await c().history(s)).filter(
      (e) =>
        e.type === 'pi.tool.result' && ['call-a', 'call-b'].includes((e.data as any).tool_use_id)
    )
    expect(parallelCalls.map((e) => (e.data as any).tool_use_id)).toEqual(['call-b', 'call-a'])
    const crash = await send('crash')
    await completed(crash, 'delivery_unknown')
    const hang = await send('hang')
    const question = await pending()
    await c().interrupt(s, question.run_id)
    await completed(hang, 'delivery_unknown')
    await c().disconnect()
    await daemon!.stop()
    daemon = undefined
    await start()
    expect((await c().getSession(s)).native_session_file).toBe(replaced.native_session_file)
    const resumed = await send('resume')
    await completed(resumed)
    expect(readFileSync(join(workspace.path, 'pi-resumed.txt'), 'utf8')).toBe(
      replaced.native_session_id
    )
    const prompts = await c().prompts(s)
    expect(prompts.filter((p) => p.state === 'resolved').every((p) => p.delivered)).toBe(true)
    expect(JSON.stringify(await c().history(s))).not.toContain(
      'Authorization Bearer FAKE_CREDENTIAL'
    )
  } catch (error) {
    console.error(
      'pi fixture failed',
      error,
      await client?.store.transaction((s) =>
        Object.fromEntries(
          Object.entries(s.events).map(([id, events]) => [id, events.slice(-15).map((e) => e.type)])
        )
      )
    )
    throw error
  } finally {
    await client?.disconnect()
    await daemon?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 12)
