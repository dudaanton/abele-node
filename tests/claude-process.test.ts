import { afterEach, expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition, withProcessDeadline } from '../scripts/process-test-budget.mjs'
import {
  mkdtempSync,
  cpSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
  mkdirSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeProviderAdapter, type ClaudeEvent, type ProviderRun } from '@abele/provider-claude'
import { identity, ProcessSupervisor } from '../packages/provider-claude/src/supervisor.js'
import { spawn } from 'node:child_process'
const dirs: string[] = [],
  runs: ProviderRun[] = []
const until = (test: () => boolean) => waitForProcessCondition(test, 'Claude process evidence')
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'abele-claude-process-'))
  dirs.push(cwd)
  const executable = join(cwd, 'claude-fixture.mjs')
  cpSync(fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url)), executable)
  chmodSync(executable, 0o700)
  return { cwd, executable }
}
afterEach(async () => {
  for (const run of runs.splice(0)) {
    await run.interrupt()
    await run.done
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('uses immutable process start evidence, not a mutable argv or process title', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message',()=>{process.title='abele-title-change';console.log('ready')});setInterval(()=>{},1000)",
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] }
  )
  const closed = new Promise<void>((r) => child.once('close', () => r()))
  let output = ''
  child.stdout!.on('data', (d) => (output += d))
  try {
    await new Promise<void>((r) => child.once('spawn', r))
    const before = identity(child.pid!)!
    child.send('change title')
    await until(() => output.includes('ready'))
    expect(identity(child.pid!)?.fingerprint).toBe(before.fingerprint)
    await ProcessSupervisor.cleanup([before])
    expect(identity(child.pid!)).toBeUndefined()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
})
it('refuses unknown CLI versions and validates bounds before running the executable', () => {
  const f = fixture()
  writeFileSync(f.executable, readFileSync(f.executable, 'utf8').replace('2.1.291', '9.9.999'))
  const unknown = new ClaudeProviderAdapter({ executable: f.executable })
  expect(unknown.available).toBe(false)
  expect(unknown.diagnostic).toMatch(/incompatible/)
  expect(unknown.diagnostic).toContain('scripts/acceptance-stage3.mjs')
  expect(new ClaudeProviderAdapter({ executable: '/no-such-abele-claude' }).available).toBe(false)
  expect(() => new ClaudeProviderAdapter({ executable: f.executable, budgetUsd: -1 })).toThrow(
    /invalid_claude_configuration/
  )
  expect(
    () => new ClaudeProviderAdapter({ executable: f.executable, deadlineMs: Infinity })
  ).toThrow(/invalid_claude_configuration/)
})
it('allows only the exact observed tool, denies mismatch and journals raw evidence separately', async () => {
  for (const text of ['allow', 'mismatch', 'bad-token']) {
    const f = fixture(),
      events: ClaudeEvent[] = []
    let prompts = 0,
      delivered = 0
    const adapter = new ClaudeProviderAdapter({
      executable: f.executable,
      profile: 'isolated',
      deadlineMs: 10000,
    })
    const run = await adapter.startTurn(
      { session_id: 's', run_id: 'r', cwd: f.cwd, text },
      {
        event: (e) => events.push(e),
        processes: () => {},
        permission: async (a) => {
          prompts++
          expect(a.input).toEqual({ command: 'printf fixture > action.txt' })
          return {
            choice: 'allow',
            delivered: () => {
              delivered++
            },
          }
        },
      }
    )
    runs.push(run)
    const result = await run.done
    expect(result.reason).toBeUndefined()
    expect(result.result?.result).toBe(text === 'allow' ? 'allow' : 'deny')
    expect(existsSync(join(f.cwd, 'action.txt'))).toBe(text === 'allow')
    expect(prompts).toBe(text === 'allow' ? 1 : 0)
    expect(delivered).toBe(text === 'allow' ? 1 : 0)
    expect(events.some((e) => e.type === 'claude.raw')).toBe(true)
  }
}, 12)
it('repository allow rules cannot bypass node approval by default, but an explicit per-project opt-in enables them', async () => {
  for (const optIn of [false, true]) {
    const f = fixture()
    mkdirSync(join(f.cwd, '.claude'))
    writeFileSync(
      join(f.cwd, '.claude/settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } })
    )
    const adapter = new ClaudeProviderAdapter({ executable: f.executable })
    let prompts = 0
    const run = await adapter.startTurn(
      {
        session_id: 's',
        run_id: 'r',
        cwd: f.cwd,
        text: 'settings',
        use_repository_claude_permissions: optIn,
      },
      {
        event: () => {},
        processes: () => {},
        permission: async () => {
          prompts++
          return { choice: 'deny', delivered() {} }
        },
      }
    )
    runs.push(run)
    await run.done
    expect(existsSync(join(f.cwd, 'action.txt'))).toBe(optIn)
    expect(prompts).toBe(optIn ? 0 : 1)
    const args = JSON.parse(readFileSync(join(f.cwd, 'invocations.jsonl'), 'utf8').trim())
      .args as string[]
    expect(args[args.indexOf('--setting-sources') + 1]).toBe(optIn ? 'user,project,local' : 'user')
  }
})
it('keeps user-level allow rules and journals their execution as settings authorization, not node approval', async () => {
  const f = fixture()
  writeFileSync(
    join(f.cwd, 'fake-user-settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash'] } })
  )
  const events: ClaudeEvent[] = [],
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  let prompts = 0
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'settings' },
    {
      event: (e) => events.push(e),
      processes: () => {},
      permission: async () => {
        prompts++
        return { choice: 'deny', delivered() {} }
      },
    }
  )
  runs.push(run)
  expect((await run.done).reason).toBeUndefined()
  expect(prompts).toBe(0)
  expect(events.find((e) => e.type === 'claude.tool.authorization')?.data).toMatchObject({
    tool_use_id: 'call',
    authorization: 'claude_settings',
    settings_sources: ['user'],
    label: 'Allowed by your Claude settings',
  })
})
it('pins a resolved executable so a global symlink update cannot switch a checked binary', async () => {
  const f = fixture(),
    alias = join(f.cwd, 'current-cli'),
    replacement = join(f.cwd, 'replacement.mjs')
  symlinkSync(f.executable, alias)
  const adapter = new ClaudeProviderAdapter({ executable: alias })
  writeFileSync(replacement, readFileSync(f.executable, 'utf8').replace('2.1.291', '9.9.999'))
  chmodSync(replacement, 0o700)
  unlinkSync(alias)
  symlinkSync(replacement, alias)
  expect(adapter.executable).toBe(realpathSync(f.executable))
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'no-result' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  expect((await run.done).reason).toBe('no_terminal_result')
})
it('journals an independently owned worker group before any external CLI launch', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable }),
    proof: Parameters<typeof adapter.reconcile>[0] = []
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'no-result' },
    {
      event: () => {},
      processes: (p) => proof.push(...p),
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  await run.done
  expect(proof[0]!.group).toBe(proof[0]!.pid)
})
it('does not grant when delivery confirmation cannot be committed on the node', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'allow' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({
        choice: 'allow',
        delivered() {
          throw new Error('storage_unavailable')
        },
      }),
    }
  )
  runs.push(run)
  const result = await run.done
  expect(result.reason).toBe('storage_unavailable')
  expect(existsSync(join(f.cwd, 'action.txt'))).toBe(false)
})
it('accepts semantically identical original JSON even when MCP serializes object keys in another order', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'reordered' },
    {
      event: () => {},
      processes: () => {},
      permission: async (a) => {
        expect(a.input).toEqual({ command: 'printf fixture > action.txt', description: 'fixture' })
        return { choice: 'allow', delivered() {} }
      },
    }
  )
  runs.push(run)
  expect((await run.done).result?.result).toBe('allow')
  expect(existsSync(join(f.cwd, 'action.txt'))).toBe(true)
})
it('two concurrent identical MCP tools/call requests cannot consume one approval twice', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  let approvals = 0,
    delivered = 0
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'duplicate' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => {
        approvals++
        await until(() => existsSync(join(f.cwd, 'duplicate-denied.txt')))
        return {
          choice: 'allow',
          delivered() {
            delivered++
          },
        }
      },
    }
  )
  runs.push(run)
  await run.done
  expect(JSON.parse(readFileSync(join(f.cwd, 'duplicate.json'), 'utf8')).sort()).toEqual([
    'allow',
    'deny',
  ])
  expect(approvals).toBe(1)
  expect(delivered).toBe(1)
})
it('reports unsupported questions explicitly and never asks for a pretend permission answer', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable }),
    events: ClaudeEvent[] = []
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'question' },
    {
      event: (e) => events.push(e),
      processes: () => {},
      permission: async () => {
        throw new Error('unsupported question must not become a permission')
      },
    }
  )
  runs.push(run)
  expect((await run.done).result?.result).toBe('deny')
  expect(events.find((e) => e.type === 'claude.unsupported_tool')?.data).toMatchObject({
    tool_name: 'AskUserQuestion',
    reason: 'Question-response bridge unsupported',
  })
})
it('never infers success from exit 0 without a terminal provider record', async () => {
  const f = fixture()
  const adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'no-result' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  expect(await run.done).toEqual({ reason: 'no_terminal_result' })
})
it('interrupts a worker and its shell descendants without reporting success', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'hang' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  await until(() => existsSync(join(f.cwd, 'descendant.pid')))
  const pid = Number(readFileSync(join(f.cwd, 'descendant.pid'), 'utf8'))
  expect(identity(pid)).toBeDefined()
  await run.interrupt()
  expect((await run.done).reason).toBe('interrupted')
  expect(identity(pid)).toBeUndefined()
})
it('retains explicit API failure independently of a nonzero CLI exit', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'api-error' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  const result = await run.done
  expect(result.result?.is_error).toBe(true)
  expect(result.reason).toBeUndefined()
})
it('cleans an orphan in the Claude group even if the CLI exits before the first inventory poll', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'background' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  await run.done
  const pid = Number(readFileSync(join(f.cwd, 'descendant.pid'), 'utf8'))
  try {
    expect(identity(pid)).toBeUndefined()
  } finally {
    if (identity(pid)) process.kill(pid, 'SIGKILL')
  }
})
it('preserves successful CLI exit after the final result is published while the supervisor is busy', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable }),
    events: ClaudeEvent[] = []
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'delegation-report' },
    {
      event: (e) => {
        events.push(e)
        // Reproduce the worker closing IPC before the supervisor acknowledges
        // the last output chunk, after the result has already been published.
        if (e.type === 'claude.result')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
      },
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
  expect((await run.done).reason).toBeUndefined()
  expect(events.find((e) => e.type === 'claude.worker.exit')?.data).toMatchObject({
    exit_code: 0,
    cleanup_confirmed: true,
  })
})
it('worker loss after a terminal record remains unknown and requires cleanup evidence', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  let workerPid = 0
  const evidence: Parameters<typeof adapter.reconcile>[0] = []
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'worker-loss' },
    {
      event: (e) => {
        if (e.type === 'claude.result') process.kill(workerPid, 'SIGKILL')
      },
      processes: (p) => {
        if (!workerPid) workerPid = p[0]!.pid
        evidence.push(...p)
      },
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  runs.push(run)
  const result = await run.done
  await adapter.reconcile(evidence)
  expect(result.reason).toBe('worker_lost')
})
it('bridge process death aborts a pending approval and cannot create the file', async () => {
  const f = fixture(),
    adapter = new ClaudeProviderAdapter({ executable: f.executable })
  let lost = false
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.cwd, text: 'allow' },
    {
      event: () => {},
      processes: () => {},
      permission: async (_a, signal) => {
        const pid = Number(readFileSync(join(f.cwd, 'bridge.pid'), 'utf8'))
        const aborted = new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              lost = true
              resolve()
            },
            { once: true }
          )
        )
        process.kill(pid, 'SIGKILL')
        await withProcessDeadline(() => aborted, 'bridge loss abort')
        return {
          choice: 'allow',
          delivered() {
            throw new Error('must not deliver')
          },
        }
      },
    }
  )
  runs.push(run)
  await run.done
  expect(lost).toBe(true)
  expect(existsSync(join(f.cwd, 'action.txt'))).toBe(false)
})
