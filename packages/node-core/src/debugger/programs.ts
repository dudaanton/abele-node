import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { ownedDebugPids } from './process.js'

/** A Node.js program on this machine whose inspector listens on loopback: what attach takes. */
export type InspectorProgram = {
  pid: number
  port: number
  /** The command line, without the path of Node itself, cut to a line. */
  command: string
  cwd: string | null
  /** The file it runs, resolved against its folder, when the command line names one. */
  script: string | null
}

const COMMAND_CHARS = 200
const NODE_NAME = /^node(js)?\d*$/
// Options of node that take the next word as their value, so it is not the program.
const VALUED = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--title',
  '--inspect-port',
  '--debug-port',
  '--input-type',
  '--stack-size',
  '--max-old-space-size',
  '--cpu-prof-dir',
  '--heap-prof-dir',
  '--diagnostic-dir',
  '--redirect-warnings',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--watch-path',
])

/** OS reads only: lsof and ps on macOS, /proc on Linux. argv, never a shell. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((done) =>
    execFile(
      file,
      args,
      { timeout: 3000, maxBuffer: 1024 * 1024, env: { LC_ALL: 'C' } },
      // lsof answers 1 when it found nothing: an empty list, not a failure.
      (_error, stdout) => done(String(stdout ?? ''))
    )
  )
}

type Listening = {
  pid: number
  ports: Set<number>
  argv: string[]
  cwd: string | null
}

async function darwinListening(): Promise<Listening[]> {
  const out = await run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP@127.0.0.1', '-sTCP:LISTEN', '-Fpcn'])
  const found = new Map<number, Set<number>>()
  let pid = 0,
    node = false
  for (const line of out.split('\n')) {
    const value = line.slice(1)
    if (line[0] === 'p') pid = Number(value)
    else if (line[0] === 'c') node = NODE_NAME.test(value)
    else if (line[0] === 'n' && node && pid > 0) {
      const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(value)?.[1])
      if (port) found.set(pid, (found.get(pid) ?? new Set()).add(port))
    }
  }
  return Promise.all(
    [...found].map(async ([pid, ports]) => {
      const [args, cwd] = await Promise.all([
        run('/bin/ps', ['-o', 'args=', '-p', String(pid)]),
        run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
      ])
      const folder = cwd.split('\n').find((l) => l.startsWith('n'))
      // ps joins the arguments with spaces: a path with a space in it reads as two words here.
      return {
        pid,
        ports,
        argv: args.trim().split(/\s+/).filter(Boolean),
        cwd: folder ? folder.slice(1) : null,
      }
    })
  )
}

async function linuxListening(): Promise<Listening[]> {
  const ports = new Map<string, number>()
  const table = await readFile('/proc/net/tcp', 'utf8').catch(() => '')
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    // Local address 127.0.0.1 is 0100007F as the kernel prints it; 0A is LISTEN.
    const [address, port] = (f[1] ?? '').split(':')
    if (address === '0100007F' && f[3] === '0A' && port && f[9]) ports.set(f[9], parseInt(port, 16))
  }
  if (!ports.size) return []
  const result: Listening[] = []
  for (const name of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const exe = await readlink(`/proc/${pid}/exe`)
      if (!NODE_NAME.test(basename(exe.replace(/ \(deleted\)$/, '')))) continue
      const held = new Set<number>()
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
        const port = inode && ports.get(inode)
        if (port) held.add(port)
      }
      if (!held.size) continue
      const [cmdline, cwd] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
        readlink(`/proc/${pid}/cwd`).catch(() => null),
      ])
      result.push({
        pid,
        ports: held,
        argv: cmdline.split('\0').filter((s, i, all) => s || i < all.length - 1),
        cwd,
      })
    } catch {
      // Gone meanwhile, or another user's: not ours to attach to.
    }
  }
  return result
}

/** When the process had started at the latest, in milliseconds, to the second: what it loaded
 * was on disk by then. Read as time elapsed, which no time zone can shift. */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (process.platform === 'darwin') {
    // [[dd-]hh:]mm:ss, whole seconds gone by: the start lies within the second before that.
    const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(
      (await run('/bin/ps', ['-o', 'etime=', '-p', String(pid)])).trim()
    )
    if (!m) return null
    const [, days, hours, minutes, seconds] = m.map((v) => Number(v ?? 0))
    const elapsed = ((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!
    return Date.now() - (elapsed + 1) * 1000
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
      const boot = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1])
      // USER_HZ is 100 on every Linux this runs on.
      return Number.isFinite(ticks) && boot ? boot * 1000 + Math.floor(ticks / 100) * 1000 : null
    } catch {
      return null
    }
  }
  return null
}

/** Whether the port answers as Node's inspector does, so a program's own server is not offered. */
export function isInspector(port: number, timeout = 1000): Promise<boolean> {
  return new Promise((done) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/json/version', timeout, headers: { host: 'localhost' } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        res.on('end', () => {
          try {
            done(/^node\.js\//.test(JSON.parse(body).Browser))
          } catch {
            done(false)
          }
        })
        res.on('error', () => done(false))
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(false))
    req.end()
  })
}

/** The file a node command line runs: its first word that is not an option or an option's value. */
export function scriptOf(argv: string[], cwd: string | null): string | null {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--') return resolveIn(argv[i + 1], cwd)
    if (['-e', '--eval', '-p', '--print', '-'].includes(word)) return null
    if (word.startsWith('-')) {
      if (VALUED.has(word)) i++
      continue
    }
    return resolveIn(word, cwd)
  }
  return null
}
function resolveIn(word: string | undefined, cwd: string | null) {
  if (!word) return null
  if (isAbsolute(word)) return word
  return cwd ? resolve(cwd, word) : null
}

export function shortCommand(argv: string[]) {
  const words = [basename(argv[0] ?? 'node'), ...argv.slice(1)].join(' ')
  return words.length > COMMAND_CHARS ? words.slice(0, COMMAND_CHARS - 1) + '…' : words
}

/** Node.js programs of this user that wait for a debugger on loopback, the node's own left out:
 * itself and what it started (programs it runs under the debugger, the adapter). */
export async function inspectorPrograms(): Promise<InspectorProgram[]> {
  const listening =
    process.platform === 'darwin'
      ? await darwinListening()
      : process.platform === 'linux'
        ? await linuxListening()
        : []
  // Every port at once: the inspector answers at once, a server that does not keeps one waiting.
  const probes = listening
    .filter((p) => p.pid !== process.pid && !ownedDebugPids.has(p.pid))
    .flatMap((p) => [...p.ports].map((port) => ({ p, port })))
  const answers = await Promise.all(probes.map(({ port }) => isInspector(port, 500)))
  const programs: InspectorProgram[] = probes
    .filter((_, i) => answers[i])
    .map(({ p, port }) => ({
      pid: p.pid,
      port,
      command: shortCommand(p.argv),
      cwd: p.cwd,
      script: scriptOf(p.argv, p.cwd),
    }))
  return programs.sort((a, b) => a.pid - b.pid || a.port - b.port)
}
