import { expect } from 'vitest'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  cpSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { NodeCore, ClaudeProviderAdapter, type LiveOptions } from '@abele/node-core'
import type { ClaudeOptions } from '@abele/provider-claude'

// Long-lived owner sessions over the fake CLI, with a node that can restart in between.
export const until = <T>(test: () => T) =>
  waitForProcessCondition(test, 'long-lived Claude session')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const cleanups: (() => Promise<void>)[] = []
/** Call from afterEach: ends every session and removes every node the test made. */
export async function cleanupLive() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}
export async function setup(options: ClaudeOptions = {}, live: LiveOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-survive-')),
    repo = join(dir, 'repo'),
    state = join(dir, 'state'),
    executable = join(dir, 'claude-live.mjs')
  cpSync(fileURLToPath(new URL('./fixtures/claude-live.mjs', import.meta.url)), executable)
  chmodSync(executable, 0o700)
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
  const adapter = () => new ClaudeProviderAdapter({ executable, profile: 'isolated', ...options })
  let core = new NodeCore(state, { claude: adapter(), live })
  const token = core.createToken('test').token
  const request = (method: string, p: unknown) =>
    core.request(core.authority.authenticate(token), method, p, crypto.randomUUID()) as any
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  // One workspace per session: two running sessions cannot share an execution target.
  const workspaces: string[] = []
  const workspace = async () => {
    const job = await request('workspace.create', { project_id: project.project_id })
    await core.resources.jobs.drain()
    workspaces.push(core.resources.workspaces.get(job.workspace_id).path)
    return job.workspace_id as string
  }
  let draining: Promise<void> | undefined
  let pump: ReturnType<typeof setInterval> | undefined
  const run = () =>
    (pump = setInterval(() => {
      draining ??= core.claude.drain().finally(() => (draining = undefined))
    }, 10))
  run()
  const halt = async (keepLive: boolean) => {
    clearInterval(pump)
    await draining
    await core.claude.stop({ keepLive })
    await core.resources.stop()
    core.close()
  }
  /** The daemon goes away with its sessions left running, then a fresh one starts and adopts them. */
  const restart = async (between?: () => unknown) => {
    await halt(true)
    await between?.()
    core = new NodeCore(state, { claude: adapter(), live })
    await core.resources.ready
    await core.claude.reconcile()
    run()
  }
  cleanups.push(async () => {
    await halt(false)
    rmSync(dir, { recursive: true, force: true })
  })
  const session = async (title = 'Owner', settings?: Record<string, unknown>) =>
    request('session.create', {
      title,
      provider: 'claude',
      workspace_id: await workspace(),
      ...(settings ? { settings } : {}),
    }).session_id as string
  const events = (session_id: string, type?: string) => {
    const all: any[] = []
    for (let after = 0; ;) {
      const page = core.read(session_id, after, 256)
      if (!page.length) break
      all.push(...page)
      after = page.at(-1)!.seq
    }
    return type ? all.filter((e) => e.type === type) : all
  }
  const send = (session_id: string, text: string) =>
    request('session.send', { session_id, text, observed_seq: 0 }).input_id as string
  const input = (input_id: string) =>
    core.db.prepare('SELECT state, run_id FROM inputs WHERE input_id=?').get(input_id) as {
      state: string
      run_id: string
    }
  const invocations = () =>
    workspaces.flatMap((path) =>
      existsSync(join(path, 'invocations.jsonl'))
        ? readFileSync(join(path, 'invocations.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { args: string[]; pid: number })
        : []
    )
  const replies = (session_id: string) =>
    events(session_id, 'claude.message.final')
      .filter((e) => e.data.role === 'assistant')
      .map((e) => e.data.content.map((b: any) => b.text).join(''))
  return {
    get core() {
      return core
    },
    request,
    session,
    events,
    send,
    input,
    invocations,
    replies,
    restart,
  }
}
