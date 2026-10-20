import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as programs from '../../packages/node-core/src/debugger/programs.js'
import { NodeCore, type LaunchProfile } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import {
  inspectorPrograms,
  processStartedAt,
  scriptOf,
  shortCommand,
} from '../../packages/node-core/src/debugger/programs.js'
import { wire } from './dap-wire.js'
import { adapter } from '../trace/adapter.js'

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

function folder(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'debug-attach-')))
  dirs.push(dir)
  // Keep CommonJS fixtures independent of the package surrounding a custom TMPDIR.
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const SERVE = 'setInterval(() => {}, 1000)\n'

/** Starts node in `cwd` with `args` and resolves once it prints what `ready` matches. */
async function node(cwd: string, args: string[], ready: RegExp) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let text = ''
  const match = await new Promise<RegExpExecArray>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('not ready: ' + text)), 10000)
    const check = (chunk: Buffer) => {
      text += chunk.toString()
      const m = ready.exec(text)
      if (m) {
        clearTimeout(timer)
        resolve(m)
      }
    }
    child.stdout!.on('data', check)
    child.stderr!.on('data', check)
    child.once('exit', () => reject(new Error('exited: ' + text)))
  })
  return { child, pid: child.pid!, port: Number(match[1]) }
}
const inspected = (cwd: string, script = 'app.js', host = '127.0.0.1') =>
  node(cwd, [`--inspect=${host}:0`, script], /Debugger listening on ws:\/\/[^:]+:(\d+)\//)

describe('Node.js programs waiting for a debugger', () => {
  it('lists a program whose inspector listens on loopback, with its folder and file', async () => {
    const dir = folder({ 'app.js': SERVE })
    const program = await inspected(dir)
    const found = (await inspectorPrograms()).find((p) => p.pid === program.pid)
    expect(found).toEqual({
      pid: program.pid,
      port: program.port,
      command: expect.stringMatching(/^node\S* --inspect=127\.0\.0\.1:0 app\.js$/),
      cwd: dir,
      script: join(dir, 'app.js'),
    })
  })

  it('reads a program file and folder whose names have spaces in them', async () => {
    const dir = folder({ 'sample tools/my app.js': SERVE })
    const program = await inspected(join(dir, 'sample tools'), 'my app.js')
    const found = (await inspectorPrograms()).find((p) => p.pid === program.pid)
    expect(found).toMatchObject({
      cwd: join(dir, 'sample tools'),
      script: join(dir, 'sample tools', 'my app.js'),
      command: expect.stringMatching(/ my app\.js$/),
    })
  })

  it('takes the words of a path back together only where the file is there', () => {
    const exists = (path: string) => path === '/w/my app.js'
    expect(scriptOf(['node', '--inspect', 'my', 'app.js', '--port', '3'], '/w', exists)).toBe(
      '/w/my app.js'
    )
    // Without such a file the first word is the program, as before.
    expect(scriptOf(['node', '--inspect', 'other', 'app.js'], '/w', exists)).toBe('/w/other')
  })

  it('leaves out a program’s own server and an inspector open beyond loopback', async () => {
    const dir = folder({
      'server.js':
        "const s = require('http').createServer(() => {}).listen(0, '127.0.0.1', () => console.log('port ' + s.address().port))\n",
      'app.js': SERVE,
    })
    const server = await node(dir, ['server.js'], /port (\d+)/)
    const open = await inspected(dir, 'app.js', '0.0.0.0')
    const pids = (await inspectorPrograms()).map((p) => p.pid)
    expect(pids).not.toContain(server.pid)
    expect(pids).not.toContain(open.pid)
  })

  it('reads when a process started whatever time zone the node runs in', async () => {
    const zone = process.env.TZ
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = tz
        const started = await processStartedAt(process.pid)
        // This very process: started before now, and not hours before.
        expect(started, tz).toBeLessThanOrEqual(Date.now())
        expect(Date.now() - started!, tz).toBeLessThan(15 * 60 * 1000)
      }
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('reads the program file past node’s options and their values', () => {
    expect(scriptOf(['node', '--inspect', '-r', 'ts-node/register', 'src/app.ts'], '/w')).toBe(
      '/w/src/app.ts'
    )
    expect(scriptOf(['node', '--inspect=9229', '/abs/app.js', '--port', '3'], null)).toBe(
      '/abs/app.js'
    )
    expect(scriptOf(['node', '--inspect', '-e', 'x()'], '/w')).toBeNull()
    expect(scriptOf(['node', '--inspect'], '/w')).toBeNull()
    expect(shortCommand(['/usr/local/bin/node', 'a'.repeat(300)])).toHaveLength(200)
  })
})

/** A profile that attaches over a scripted adapter, as the native one does over js-debug. */
function scriptedProfile() {
  const attached: { config: any; target: any; sources: Map<string, string>; root: string }[] = []
  const make = (core: NodeCore): LaunchProfile => ({
    profiles: () => [{ id: 'js-ts-native', version: 'fixture', inspection: 'explicit-only' }],
    async launch() {
      throw new Error('not in this test')
    },
    async attach(config, target, sources, root) {
      attached.push({ config, target, sources: new Map(sources), root })
      const w = wire()
      const fake = adapter(w, () => ({}), root)
      const session = new DapSession(core.debugger, core.debugger.create(target), w.dap, sources)
      await session.start('attach', { type: 'pwa-node', port: config.port })
      return {
        root: session,
        onSession(listener) {
          listener(session)
          return () => {}
        },
        async close() {
          fake.stop()
          w.dap.close()
        },
      }
    },
  })
  return { make, attached }
}

async function setup(profile: (core: NodeCore) => LaunchProfile, chatFolder: string) {
  const state = folder({})
  const core = new NodeCore(join(state, 'state'), {
    debuggerEnabled: true,
    debuggerProfile: profile,
  })
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const request = async (method: string, p: any) =>
    (await core.request(actor, method, p, p.operation_id ?? crypto.randomUUID())) as any
  const project = await request('project.register', { path: chatFolder, trust: 'trusted' })
  const [workspace] = await request('workspace.list', { project_id: project.project_id })
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await request('project.execution', { project_id: project.project_id, target, enabled: true })
  const chat = await request('session.create', { provider: 'fake', target })
  return { core, request, project, chat }
}

describe('attaching the debugger to a running program', () => {
  it('attaches to a program of the chat’s folder as one the node does not own', async () => {
    const dir = folder({ 'app.js': SERVE, 'lib/util.js': 'module.exports = 1\n' })
    const before = new Date(Date.now() - 5000)
    utimesSync(join(dir, 'app.js'), before, before)
    // Both files must provably predate the process, whose start is known only to the second.
    utimesSync(join(dir, 'lib/util.js'), before, before)
    const program = await inspected(dir)
    const profile = scriptedProfile()
    const s = await setup(profile.make, dir)
    const listed = await s.request('debugger.v1.programs', { conversation_id: s.chat.session_id })
    expect(listed.programs.find((p: any) => p.pid === program.pid)).toMatchObject({
      port: program.port,
      in_chat_folder: true,
      project: { project_id: s.project.project_id, path: dir },
    })
    const attached = await s.request('debugger.v1.attachProgram', {
      operation_id: 'attach-1',
      conversation_id: s.chat.session_id,
      pid: program.pid,
      port: program.port,
      sources: ['lib/util.js'],
    })
    expect(attached.sources).toEqual([
      { source_id: 's1', path: 'app.js' },
      { source_id: 's2', path: 'lib/util.js' },
    ])
    expect(profile.attached).toHaveLength(1)
    expect(profile.attached[0]!.config).toEqual({
      address: '127.0.0.1',
      port: program.port,
      target_pid: program.pid,
    })
    expect(profile.attached[0]!.target).toMatchObject({
      conversation_id: s.chat.session_id,
      process_ownership: 'external',
      // Its file is what it runs: not changed since it started.
      build_identity: 'matched',
      launch_configuration_id: `app.js · pid ${program.pid}`,
    })
    // A retried operation is the same attachment, not a second one.
    const again = await s.request('debugger.v1.attachProgram', {
      operation_id: 'attach-1',
      conversation_id: s.chat.session_id,
      pid: program.pid,
      port: program.port,
    })
    expect(again.debug_session_id).toBe(attached.debug_session_id)
    expect(profile.attached).toHaveLength(1)

    // Stopping a program the node does not own is refused; detaching lets it go on.
    const id = attached.debug_session_id
    let { snapshot } = await s.request('debugger.v1.status', { debug_session_id: id })
    const stop = await s.request('debugger.v1.terminate', {
      debug_session_id: id,
      incarnation: snapshot.incarnation,
      expected_state_revision: snapshot.state_revision,
      operation_id: 'stop-1',
    })
    expect(stop.outcome).toBe('rejected')
    ;({ snapshot } = await s.request('debugger.v1.status', { debug_session_id: id }))
    const detach = await s.request('debugger.v1.detach', {
      debug_session_id: id,
      incarnation: snapshot.incarnation,
      expected_state_revision: snapshot.state_revision,
      operation_id: 'detach-1',
    })
    expect(detach.outcome).toBe('completed')
    expect(detach.snapshot.lifecycle).toBe('detached')
    expect(program.child.exitCode).toBeNull()
    expect(() => process.kill(program.pid, 0)).not.toThrow()
  })

  it('asks the owner before a program of another folder, and only ever what listens there', async () => {
    const chatDir = folder({ 'main.js': SERVE })
    const elsewhere = folder({ 'app.js': SERVE })
    const program = await inspected(elsewhere)
    const profile = scriptedProfile()
    const s = await setup(profile.make, chatDir)
    const listed = await s.request('debugger.v1.programs', { conversation_id: s.chat.session_id })
    expect(listed.programs.find((p: any) => p.pid === program.pid)).toMatchObject({
      in_chat_folder: false,
      project: null,
      cwd: elsewhere,
    })
    const attach = (extra: object) =>
      s.request('debugger.v1.attachProgram', {
        operation_id: crypto.randomUUID(),
        conversation_id: s.chat.session_id,
        pid: program.pid,
        port: program.port,
        ...extra,
      })
    await expect(attach({})).rejects.toMatchObject({ code: 'debugger_attach_outside_folder' })
    // A port the program does not listen on, or a process that is not it, is never attached.
    await expect(
      attach({ port: program.port === 1 ? 2 : 1, outside_folder: true })
    ).rejects.toMatchObject({ code: 'debugger_program_not_found' })
    await expect(attach({ pid: process.pid, outside_folder: true })).rejects.toMatchObject({
      code: 'debugger_program_not_found',
    })
    expect(profile.attached).toHaveLength(0)
    const attached = await attach({ outside_folder: true })
    // Its own file is outside the chat's folder: it takes no breakpoints from here.
    expect(attached.sources).toEqual([])
    expect(profile.attached[0]!.target.launch_configuration_id).toBe(`app.js · pid ${program.pid}`)
  })

  it('does not trust the lines of a program file changed after the program started', async () => {
    const dir = folder({ 'app.js': 'console.log("app ready")\n' + SERVE })
    const program = await node(
      dir,
      ['--inspect=127.0.0.1:0', 'app.js'],
      /ws:\/\/127\.0\.0\.1:(\d+)\/[\s\S]*app ready/
    )
    const later = new Date(Date.now() + 5000)
    writeFileSync(join(dir, 'app.js'), 'console.log("changed")\n' + SERVE)
    utimesSync(join(dir, 'app.js'), later, later)
    const profile = scriptedProfile()
    const s = await setup(profile.make, dir)
    await s.request('debugger.v1.attachProgram', {
      operation_id: 'attach-edited',
      conversation_id: s.chat.session_id,
      pid: program.pid,
      port: program.port,
    })
    expect(profile.attached[0]!.target.build_identity).toBe('unknown')
  })
  it.each(['identical', 'restored', 'diverged'])(
    'checks a %s rebuild against the script actually loaded by Node',
    async (mode) => {
      const original = 'console.log("app ready")\n' + SERVE
      const dir = folder({ 'app.js': original })
      const program = await node(
        dir,
        ['--inspect=127.0.0.1:0', 'app.js'],
        /ws:\/\/127\.0\.0\.1:(\d+)\/[\s\S]*app ready/
      )
      const discovery = vi.spyOn(programs, 'inspectorPrograms').mockResolvedValue([
        {
          pid: program.pid,
          port: program.port,
          command: 'node app.js',
          cwd: dir,
          script: join(dir, 'app.js'),
        },
      ])
      const started = vi.spyOn(programs, 'processStartedAt').mockResolvedValue(Date.now() - 5000)
      try {
        writeFileSync(
          join(dir, 'app.js'),
          mode === 'identical' ? original : 'console.log("changed")\n' + SERVE
        )
        if (mode === 'restored') writeFileSync(join(dir, 'app.js'), original)
        const profile = scriptedProfile()
        const s = await setup(profile.make, dir)
        const attached = await s.request('debugger.v1.attachProgram', {
          operation_id: 'attach-rebuilt',
          conversation_id: s.chat.session_id,
          pid: program.pid,
          port: program.port,
        })
        expect(attached.sources).toEqual(
          mode === 'diverged' ? [] : [{ source_id: 's1', path: 'app.js' }]
        )
        expect(profile.attached[0]!.target.build_identity).toBe(
          mode === 'diverged' ? 'unknown' : 'matched'
        )
        if (mode === 'diverged') {
          writeFileSync(join(dir, 'app.js'), original)
          const added = await s.request('debugger.v1.addSources', {
            operation_id: 'restored-after-attach',
            debug_session_id: attached.debug_session_id,
            sources: ['app.js'],
          })
          expect(added.refused).toEqual([])
          expect(
            s.core.debugger.snapshot(attached.debug_session_id).snapshot.target.build_identity
          ).toBe('matched')
        }
      } finally {
        discovery.mockRestore()
        started.mockRestore()
      }
    }
  )
})
