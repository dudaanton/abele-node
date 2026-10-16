import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JS_DEBUG_PIN, unpackJsAdapter } from '../../packages/node-core/src/debugger/js-install.js'

// Attaches the pinned js-debug to a real program started with --inspect. Opt-in like
// tests/trace/local-run.test.ts: install the adapter into the scratch state first
// (docs/debugger-js-profile.md).
const scratch = resolve('.scratch/debugger-integration')
const archive = JS_DEBUG_PIN
  ? join(scratch, 'state/debugger/adapters/js-debug', JS_DEBUG_PIN.version, 'archive.tar.gz')
  : ''
const enabled = process.env.ABELE_DEBUGGER_LOCAL_TEST === '1' && !!archive && existsSync(archive)

const dirs: string[] = []
const cores: NodeCore[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.debuggerLaunches.close()
    await core.execution.stop()
    await core.resources.stop()
    core.close()
  }
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PROGRAM = [
  'let ticks = 0',
  'function tick() {',
  '  ticks += 1',
  "  console.log('tick ' + ticks)",
  '}',
  'setInterval(tick, 50)',
  '',
].join('\n')

describe.skipIf(!enabled)('attaching the pinned js-debug to a running program', () => {
  it('stops it at a breakpoint and lets it run on after detaching', async () => {
    mkdirSync(scratch, { recursive: true })
    const dir = realpathSync(mkdtempSync(join(scratch, 'attach-')))
    dirs.push(dir)
    const folder = join(dir, 'folder')
    mkdirSync(folder)
    writeFileSync(join(folder, 'app.js'), PROGRAM)
    // Written well before it starts, as a program's file is: the node trusts its lines then.
    const before = new Date(Date.now() - 5000)
    utimesSync(join(folder, 'app.js'), before, before)
    const state = join(dir, 'state')
    await unpackJsAdapter(
      join(state, 'debugger/adapters/js-debug', JS_DEBUG_PIN!.version),
      JS_DEBUG_PIN!,
      readFileSync(archive)
    )
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', 'app.js'], {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout!.on('data', (c: Buffer) => (output += c.toString()))
    child.stderr!.on('data', (c: Buffer) => (output += c.toString()))
    const ticks = () => Number([...output.matchAll(/tick (\d+)/g)].at(-1)?.[1] ?? 0)
    const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => {
      const end = Date.now() + ms
      while (!(await check())) {
        if (Date.now() > end) throw new Error('local_attach_timeout: ' + output.slice(-500))
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    await until(() => /ws:\/\/127\.0\.0\.1:(\d+)\//.test(output) && ticks() > 0)
    const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)![1])

    const core = new NodeCore(state, { debuggerEnabled: true })
    cores.push(core)
    const actor = core.authority.authenticate(core.createToken('fixture').token)
    const request = async (method: string, p: any) =>
      (await core.request(actor, method, p, p.operation_id ?? crypto.randomUUID())) as any
    const project = await request('project.register', { path: folder, trust: 'trusted' })
    const [workspace] = await request('workspace.list', { project_id: project.project_id })
    const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
    await request('project.execution', { project_id: project.project_id, target, enabled: true })
    const chat = await request('session.create', { provider: 'fake', target })

    const { programs } = await request('debugger.v1.programs', {
      conversation_id: chat.session_id,
    })
    expect(programs.find((p: any) => p.pid === child.pid)).toMatchObject({
      port,
      in_chat_folder: true,
    })
    const attached = await request('debugger.v1.attachProgram', {
      operation_id: crypto.randomUUID(),
      conversation_id: chat.session_id,
      pid: child.pid,
      port,
    })
    expect(attached.sources).toEqual([{ source_id: 's1', path: 'app.js' }])
    const id = attached.debug_session_id
    const snapshot = async () =>
      (await request('debugger.v1.status', { debug_session_id: id })).snapshot
    expect((await snapshot()).target).toMatchObject({
      process_ownership: 'external',
      build_identity: 'matched',
    })

    let snap = await snapshot()
    const patched = await request('debugger.v1.breakpoints.patch', {
      debug_session_id: id,
      incarnation: snap.incarnation,
      expected_state_revision: snap.state_revision,
      operation_id: crypto.randomUUID(),
      expected_breakpoint_revision: snap.breakpoint_revision,
      upsert: [{ breakpoint_id: 'bp-1', source_id: 's1', line: 3 }],
      remove: [],
    })
    expect(patched.outcome, JSON.stringify({ ...patched, snapshot: undefined })).toBe('completed')
    await until(async () => (await snapshot()).threads.some((t: any) => t.status === 'stopped'))
    const held = ticks()
    await new Promise((r) => setTimeout(r, 300))
    expect(ticks()).toBe(held)

    // Detach: the breakpoint goes with the debugger and the program runs on, never stopped.
    snap = await snapshot()
    const detached = await request('debugger.v1.detach', {
      debug_session_id: id,
      incarnation: snap.incarnation,
      expected_state_revision: snap.state_revision,
      operation_id: crypto.randomUUID(),
    })
    expect(detached.outcome).toBe('completed')
    await until(() => ticks() > held + 3)
    expect(child.exitCode).toBeNull()
    // It waits for a debugger again, so it can be attached to once more.
    await until(async () =>
      (await request('debugger.v1.programs', { conversation_id: chat.session_id })).programs.some(
        (p: any) => p.pid === child.pid
      )
    )
  }, 60000)
})
