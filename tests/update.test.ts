import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let scratch: string, prefix: string, root: string, runtime: string, state: string
let server: Server, base: string
let routes: Map<string, string>, requests: string[]
const version = '0.3.2'
const installer = `#!/bin/sh
exec "$TEST_NODE" -e 'require("node:fs").writeFileSync(process.env.TEST_CAPTURE,JSON.stringify(process.argv.slice(1)));process.exit(Number(process.env.TEST_INSTALL_EXIT || 0))' -- "$@"
`
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

function release(target = '0.4.0', assets = ['install.sh', 'SHA256SUMS']) {
  const info = JSON.stringify({
    tag_name: `v${target}`,
    draft: false,
    prerelease: false,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `${base}/releases/download/v${target}/${name}`,
    })),
  })
  routes.set('/releases/latest', info)
  routes.set(`/releases/tags/v${target}`, info)
  routes.set(`/releases/download/v${target}/install.sh`, installer)
  routes.set(`/releases/download/v${target}/SHA256SUMS`, `${digest(installer)}  install.sh\n`)
  routes.set(`/raw/v${target}/install.sh`, installer)
}
function config(service = 0) {
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version,
      state,
      claude: join(scratch, "claude path ' with spaces"),
      service,
    })
  )
}
function activeRun() {
  const db = new DatabaseSync(join(state, 'node.sqlite'))
  db.exec(
    "CREATE TABLE provider_runs(run_id TEXT, session_id TEXT, state TEXT); INSERT INTO provider_runs VALUES('run-123','session-456','active')"
  )
  db.close()
}
async function cli(
  args: string[],
  source = false,
  extra: Record<string, string> = {},
  started?: (child: ChildProcess) => void
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        source
          ? resolve('packages/node-daemon/dist/cli.js')
          : join(root, 'current/packages/node-daemon/dist/cli.js'),
        ...args,
        '--state-dir',
        state,
        '--claude-path',
        join(scratch, 'unused override'),
      ],
      {
        env: {
          ...process.env,
          ABELE_INSTALL_API_URL: `${base}/releases/latest`,
          ABELE_INSTALL_BASE_URL: base,
          ABELE_UPDATE_RAW_URL: `${base}/raw`,
          TEST_NODE: process.execPath,
          TEST_CAPTURE: join(scratch, 'invocation.json'),
          ...extra,
        },
      }
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (b) => {
      stdout += b
    })
    child.stderr.on('data', (b) => {
      stderr += b
    })
    child.on('error', reject)
    child.on('close', (code) => done({ code, stdout, stderr }))
    started?.(child)
  })
}
beforeEach(async () => {
  mkdirSync('.scratch', { recursive: true })
  scratch = mkdtempSync(resolve('.scratch/update-test-'))
  prefix = join(scratch, "custom prefix ' spaces")
  root = join(prefix, 'share/abele-node')
  runtime = join(root, version)
  state = join(scratch, 'saved state')
  mkdirSync(join(runtime, 'packages/node-daemon'), { recursive: true })
  mkdirSync(state)
  cpSync('packages/node-daemon/dist', join(runtime, 'packages/node-daemon/dist'), {
    recursive: true,
  })
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ version, type: 'module' }))
  symlinkSync(resolve('node_modules'), join(runtime, 'node_modules'))
  symlinkSync(version, join(root, 'current'))
  writeFileSync(join(root, '.installer-owned'), '')
  config()
  routes = new Map()
  requests = []
  server = createServer((req, res) => {
    requests.push(req.url!)
    const body = routes.get(req.url!)
    res.writeHead(body === undefined ? 404 : 200)
    res.end(body ?? 'not found')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  release()
})
afterEach(async () => {
  await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())))
  rmSync(scratch, { recursive: true, force: true })
})
it('--check reports an available update and exits zero without fetching or executing code', async () => {
  activeRun()
  const result = await cli(['update', '--check'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('Current: 0.3.2')
  expect(result.stdout).toContain('Latest: 0.4.0')
  expect(result.stdout).toContain('Update available')
  expect(requests).toEqual(['/releases/latest'])
  expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
})
it.each(['0.3.2', '0.3.1', '0.2.99'])(
  'does not install the same or an older latest release (%s)',
  async (target) => {
    release(target)
    const result = await cli(['update'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('No update available')
    expect(requests).toEqual(['/releases/latest'])
  }
)
it('does not downgrade the installation when an older release is explicitly pinned', async () => {
  release('0.3.1')
  const result = await cli(['update', '--version', '0.3.1'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('No update available')
  expect(requests).toEqual(['/releases/tags/v0.3.1'])
  expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
})
it('compares version components numerically and preserves every recorded foreground option', async () => {
  release('0.10.0')
  const result = await cli(['update'])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(scratch, 'invocation.json'), 'utf8'))).toEqual([
    '--version',
    '0.10.0',
    '--prefix',
    prefix,
    '--state-dir',
    state,
    '--claude-path',
    join(scratch, "claude path ' with spaces"),
    '--no-service',
  ])
  expect(requests).toEqual([
    '/releases/latest',
    '/releases/download/v0.10.0/install.sh',
    '/releases/download/v0.10.0/SHA256SUMS',
  ])
  expect(result.stdout).toContain('Updated to 0.10.0')
})
it('resolves a pinned tag instead of latest and preserves service installation', async () => {
  config(1)
  release('0.3.9')
  const result = await cli(['update', '--version', 'v0.3.9'])
  expect(result.code, result.stderr).toBe(0)
  expect(requests[0]).toBe('/releases/tags/v0.3.9')
  expect(JSON.parse(readFileSync(join(scratch, 'invocation.json'), 'utf8'))).not.toContain(
    '--no-service'
  )
})
it('uses the recorded prefix spelling when its physical installation matches', async () => {
  const alias = join(scratch, 'prefix alias')
  symlinkSync(prefix, alias)
  const recorded = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...recorded, prefix: alias }))
  const result = await cli(['update'])
  expect(result.code, result.stderr).toBe(0)
  const invocation = JSON.parse(readFileSync(join(scratch, 'invocation.json'), 'utf8')) as string[]
  expect(invocation[invocation.indexOf('--prefix') + 1]).toBe(alias)
})
it('warns when an installer asset is published without a checksum manifest', async () => {
  release('0.4.0', ['install.sh'])
  const result = await cli(['update'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('without a publisher checksum')
  expect(requests).toEqual(['/releases/latest', '/releases/download/v0.4.0/install.sh'])
})
it('refuses a missing installer asset for latest without falling back to main or raw', async () => {
  release('0.4.0', ['SHA256SUMS'])
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--version')
  expect(requests).toEqual(['/releases/latest'])
})
it('allows an explicitly pinned legacy release only with a clear tagged HTTPS fallback note', async () => {
  release('0.4.0', ['SHA256SUMS'])
  const result = await cli(['update', '--version', '0.4.0'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/tag.*v0\.4\.0.*without.*checksum/i)
  expect(requests).toEqual(['/releases/tags/v0.4.0', '/raw/v0.4.0/install.sh'])
})
it.each(['mismatch', 'missing entry', 'duplicate entry'])(
  'refuses an invalid installer checksum: %s',
  async (mode) => {
    const line = `${digest(installer)}  install.sh\n`
    routes.set(
      '/releases/download/v0.4.0/SHA256SUMS',
      mode === 'mismatch'
        ? `${'0'.repeat(64)}  install.sh\n`
        : mode === 'duplicate entry'
          ? line + line
          : `${digest(installer)}  archive.tar.gz\n`
    )
    const result = await cli(['update', '--version', '0.4.0'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/checksum/i)
    expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
    expect(requests.some((path) => path.startsWith('/raw'))).toBe(false)
  }
)
it('does not hide a failed asset download with a raw fallback', async () => {
  routes.delete('/releases/download/v0.4.0/install.sh')
  const result = await cli(['update', '--version', '0.4.0'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('404')
  expect(requests.some((path) => path.startsWith('/raw'))).toBe(false)
})
it('refuses active runs, reports their IDs and does not fetch installer code', async () => {
  activeRun()
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('run-123')
  expect(result.stderr).toContain('session-456')
  expect(result.stderr).toContain('--force')
  expect(requests).toEqual(['/releases/latest'])
})
it('--force reports active runs and permits invoking the installer', async () => {
  activeRun()
  const result = await cli(['update', '--force'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('run-123')
  expect(existsSync(join(scratch, 'invocation.json'))).toBe(true)
})
it('rechecks active runs after downloading before invoking the installer', async () => {
  const original = server.listeners('request')[0] as (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (req.url?.endsWith('/SHA256SUMS')) activeRun()
    original(req, res)
  })
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('run-123')
  expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
})
it('holds an execution admission lock until the installer exits, then removes it', async () => {
  const guarded = `#!/bin/sh\ntest -f "$TEST_STATE/update.lock" || exit 9\n${installer}`
  routes.set('/releases/download/v0.4.0/install.sh', guarded)
  routes.set('/releases/download/v0.4.0/SHA256SUMS', `${digest(guarded)}  install.sh\n`)
  const result = await cli(['update'], false, { TEST_STATE: state })
  expect(result.code, result.stderr).toBe(0)
  expect(existsSync(join(state, 'update.lock'))).toBe(false)
})
it('refuses concurrent updates without removing another updater lock', async () => {
  const lock = JSON.stringify({ pid: process.pid })
  writeFileSync(join(state, 'update.lock'), lock)
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('update.lock')
  expect(readFileSync(join(state, 'update.lock'), 'utf8')).toBe(lock)
  expect(requests).toEqual(['/releases/latest'])
})
it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  'releases the update fence on %s during a stalled installer download',
  async (signal) => {
    const original = server.listeners('request')[0] as (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse
    ) => void
    let downloading!: () => void
    const ready = new Promise<void>((done) => {
      downloading = done
    })
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      if (req.url?.endsWith('/install.sh')) {
        res.writeHead(200)
        res.write('#!/bin/sh\n') // Hold the response body open until cancellation.
        downloading()
      } else original(req, res)
    })
    let child!: ChildProcess
    const pending = cli(['update'], false, {}, (process) => {
      child = process
    })
    try {
      await ready
      expect(existsSync(join(state, 'update.lock'))).toBe(true)
      child.kill(signal)
      const result = await pending
      // Check cleanup before retry, so stale recovery cannot hide missing signal cleanup.
      expect(existsSync(join(state, 'update.lock'))).toBe(false)
      expect(result.code).toBe({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal])
      expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
      server.removeAllListeners('request')
      server.on('request', original)
      const retry = await cli(['update'])
      expect(retry.code, retry.stderr).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await pending
    }
  }
)
it('recovers a dead updater lock and permits a later update', async () => {
  const owner = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  expect(owner.status, owner.stderr).toBe(0)
  writeFileSync(join(state, 'update.lock'), JSON.stringify({ pid: owner.pid, id: 'dead-owner' }))
  const result = await cli(['update'])
  expect(result.code, result.stderr).toBe(0)
  expect(existsSync(join(state, 'update.lock'))).toBe(false)
  expect(existsSync(join(scratch, 'invocation.json'))).toBe(true)
})
it.each(['not json', JSON.stringify({ pid: -1 }), JSON.stringify({ pid: '123' })])(
  'does not remove an unverifiable updater lock: %s',
  async (record) => {
    writeFileSync(join(state, 'update.lock'), record)
    const result = await cli(['update'])
    expect(result.code).toBe(1)
    expect(readFileSync(join(state, 'update.lock'), 'utf8')).toBe(record)
    expect(existsSync(join(scratch, 'invocation.json'))).toBe(false)
  }
)
it('does not race an in-progress provider dispatch admission', async () => {
  mkdirSync(join(state, '.run-admission'))
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('admission')
  expect(requests).toEqual(['/releases/latest'])
  expect(existsSync(join(state, 'update.lock'))).toBe(false)
  expect(existsSync(join(state, '.run-admission'))).toBe(true)
})
it('source checkout recommends git pull and performs no network or state writes', async () => {
  const result = await cli(['update'], true)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('git pull')
  expect(requests).toEqual([])
  expect(existsSync(join(state, 'node.sqlite'))).toBe(false)
})
it.each([['--version', '../main'], ['--version'], ['--bogus']])(
  'rejects invalid update arguments %j before network access',
  async (...args) => {
    const result = await cli(['update', ...args])
    expect(result.code).toBe(1)
    expect(requests).toEqual([])
  }
)
it.each(['draft', 'prerelease'])('rejects a %s release', async (kind) => {
  routes.set('/releases/latest', JSON.stringify({ tag_name: 'v0.4.0', [kind]: true, assets: [] }))
  const result = await cli(['update'])
  expect(result.code).toBe(1)
  expect(requests).toEqual(['/releases/latest'])
})
it.each([false, true])(
  'update check is plain text by default and structured with --json=%s',
  async (json) => {
    const result = await cli(['update', '--check', ...(json ? ['--json'] : [])])
    expect(result.code, result.stderr).toBe(0)
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'update',
        status: 'checked',
        current: '0.3.2',
        target: '0.4.0',
        update_available: true,
        check: true,
        exit_code: 0,
        agents: { admission_paused: false, admission_resumed: false, active_runs: [] },
        installer: null,
      })
      expect(result.stderr).toBe('')
    } else {
      expect(() => JSON.parse(result.stdout)).toThrow()
      expect(result.stdout).toContain('Current: 0.3.2')
      expect(result.stdout).toContain('Latest: 0.4.0')
      expect(result.stdout).toContain('Next: abele-node update')
      expect(result.stdout).not.toContain('Agent turns paused')
    }
    expect(requests).toEqual(['/releases/latest'])
  }
)
it.each(['0.3.2', '0.3.9'])(
  'pinned update checks keep the target and next step in JSON: %s',
  async (target) => {
    release(target)
    const result = await cli(['update', '--check', '--version', target, '--json'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'checked',
      target,
      target_kind: 'pinned',
      current: '0.3.2',
      update_available: target !== '0.3.2',
      next_step: target !== '0.3.2' ? `abele-node update --version ${target}` : 'abele-node status',
      agents: { admission_paused: false },
      installer: null,
    })
    expect(requests).toEqual([`/releases/tags/v${target}`])
    expect(existsSync(join(state, 'update.lock'))).toBe(false)
  }
)
it.each([false, true])(
  'update success contains no raw installer output with --json=%s',
  async (json) => {
    const noisy = `#!/bin/sh\nprintf '%s\\n' '{"internal_installer_report":"not a user message"}'\nprintf '%s\\n' 'internal installer stderr' >&2\n${installer}`
    routes.set('/releases/download/v0.4.0/install.sh', noisy)
    routes.set('/releases/download/v0.4.0/SHA256SUMS', `${digest(noisy)}  install.sh\n`)
    const result = await cli(['update', ...(json ? ['--json'] : [])])
    expect(result.code, result.stderr).toBe(0)
    if (json) {
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        command: 'update',
        status: 'updated',
        current: '0.3.2',
        target: '0.4.0',
        exit_code: 0,
        prefix,
        state_dir: state,
        service: false,
        agents: { admission_paused: true, admission_resumed: true, active_runs: [] },
        installer: {
          exit_code: 0,
          signal: null,
          stdout: '{"internal_installer_report":"not a user message"}\n',
          stderr: 'internal installer stderr\n',
        },
      })
      expect(result.stderr).toBe('')
    } else {
      expect(result.stdout).toContain('Agent turns paused')
      expect(result.stdout).toContain('Updated to 0.4.0')
      expect(result.stdout).toContain('Agent turns resumed')
      expect(result.stdout).toContain('Next: abele-node start')
      expect(result.stdout).not.toContain('internal_installer_report')
      expect(result.stdout).not.toContain('internal installer stderr')
      expect(result.stdout.trim().split('\n').length).toBeLessThanOrEqual(7)
      expect(result.stderr).toBe('')
    }
  }
)
it.each([false, true])(
  'update failure explains recovery without mixing installer output with --json=%s',
  async (json) => {
    const broken = `#!/bin/sh\nprintf '%s\\n' 'abele-node: Service ownership modified; refusing to stop it.' >&2\nprintf '%s\\n' '{"raw_failure":"diagnostic"}'\nexit 7\n`
    routes.set('/releases/download/v0.4.0/install.sh', broken)
    routes.set('/releases/download/v0.4.0/SHA256SUMS', `${digest(broken)}  install.sh\n`)
    const result = await cli(['update', ...(json ? ['--json'] : [])])
    expect(result.code).toBe(7)
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'update',
        status: 'failed',
        current: '0.3.2',
        target: '0.4.0',
        exit_code: 7,
        agents: { admission_paused: true, admission_resumed: true },
        installer: {
          exit_code: 7,
          stdout: '{"raw_failure":"diagnostic"}\n',
          stderr: 'abele-node: Service ownership modified; refusing to stop it.\n',
        },
        error: expect.stringContaining('installer failed'),
        next_step: expect.stringContaining('abele-node doctor'),
      })
      expect(result.stderr).toBe('')
    } else {
      expect(result.stderr).toContain('Update failed')
      expect(result.stderr).toContain('Service ownership modified')
      expect(result.stderr).toContain('Agent turns resumed')
      expect(result.stderr).toContain('abele-node doctor')
      expect(result.stdout).not.toContain('raw_failure')
    }
    expect(existsSync(join(state, 'update.lock'))).toBe(false)
  }
)
it('JSON reports active runs and refuses them without printing human progress', async () => {
  activeRun()
  const result = await cli(['update', '--json'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('--force'),
    agents: {
      active_runs: [{ run_id: 'run-123', session_id: 'session-456' }],
      admission_resumed: true,
    },
    installer: null,
  })
  expect(result.stderr).toBe('')
  expect(requests).toEqual(['/releases/latest'])
})
it('force update explains that running agents must be stopped by the installer', async () => {
  config(1)
  activeRun()
  const result = await cli(['update', '--force'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('run-123')
  expect(result.stdout).toContain('waiting for the installer to stop running agents')
  expect(result.stdout).toContain('Next: abele-node status')
})
it('source checkout update supports an explicit JSON report without network access', async () => {
  const result = await cli(['update', '--json'], true)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'update',
    status: 'source',
    exit_code: 0,
    next_step: expect.stringContaining('git pull'),
  })
  expect(requests).toEqual([])
})
it('JSON interruption reports the signal and resumed admission without human output', async () => {
  const original = server.listeners('request')[0] as (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void
  let downloading!: () => void
  const ready = new Promise<void>((done) => {
    downloading = done
  })
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (req.url?.endsWith('/SHA256SUMS')) {
      res.writeHead(200)
      res.write('pending checksum')
      downloading()
    } else original(req, res)
  })
  let child!: ChildProcess
  const pending = cli(['update', '--json'], false, {}, (process) => {
    child = process
  })
  try {
    await ready
    child.kill('SIGINT')
    const result = await pending
    expect(result.code).toBe(130)
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'update',
      status: 'interrupted',
      current: '0.3.2',
      target: '0.4.0',
      exit_code: 130,
      error: expect.stringContaining('SIGINT'),
      agents: { admission_paused: true, admission_resumed: true },
      installer: null,
    })
    expect(result.stderr).toBe('')
    expect(existsSync(join(state, 'update.lock'))).toBe(false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await pending
  }
})
it('invalid update arguments are structured when --json is requested', async () => {
  const result = await cli(['update', '--bogus', '--json'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'update',
    status: 'failed',
    error: expect.stringContaining('--bogus'),
    exit_code: 1,
  })
  expect(result.stderr).toBe('')
  expect(requests).toEqual([])
})
it('propagates installer failure without claiming success and cleans downloaded code', async () => {
  const result = await cli(['update'], false, { TEST_INSTALL_EXIT: '7' })
  expect(result.code).toBe(7)
  expect(result.stdout).not.toContain('Updated to')
  expect(result.stderr).toContain('installer')
  expect(existsSync(join(state, 'update.lock'))).toBe(false)
  // Temporary downloaded code is removed on success and failure.
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(root).some((name) => name.startsWith('.update-'))).toBe(false)
})
