import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { acquireUpdateLock } from '@abele/node-core'

type Options = { version?: string; check: boolean; force: boolean }
type ActiveRun = { run_id: string; session_id: string }
export type UpdateReport = {
  command: 'update'
  status:
    | 'checking'
    | 'available'
    | 'paused'
    | 'warning'
    | 'checked'
    | 'up_to_date'
    | 'source'
    | 'updated'
    | 'failed'
    | 'interrupted'
  current: string | null
  target: string | null
  target_kind: 'latest' | 'pinned'
  update_available: boolean
  check: boolean
  force: boolean
  exit_code: number
  prefix: string | null
  state_dir: string | null
  claude_path: string | null
  service: boolean | null
  agents: { admission_paused: boolean; admission_resumed: boolean; active_runs: ActiveRun[] }
  warnings: string[]
  installer: {
    exit_code: number
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  } | null
  error: string | null
  next_step: string
}
function parse(args: string[]): Options {
  const options: Options = { check: false, force: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--check') options.check = true
    else if (arg === '--force') options.force = true
    else if (arg === '--version') options.version = version(args[++i] ?? '')
    else
      throw new Error(
        `Unknown update option: ${arg}. Usage: abele-node update [--version X.Y.Z] [--check] [--force] [--json]`
      )
  }
  return options
}
function version(value: string): string {
  if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid version; expected X.Y.Z.')
  return value.replace(/^v/, '')
}
function compare(a: string, b: string): number {
  const left = a.split('.').map(BigInt),
    right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) return 1
    if (left[i]! < right[i]!) return -1
  }
  return 0
}
function absolute(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    resolve(value) !== value ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`Invalid installer config ${name}; inspect the installation before updating.`)
  return value
}
// HTTPS for real endpoints; HTTP is permitted only on loopback for offline tests.
function endpoint(value: string): URL {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  )
    throw new Error('Update downloads require HTTPS (except loopback test servers).')
  return url
}
async function download(value: string, interrupted?: AbortSignal): Promise<Buffer> {
  let url = endpoint(value)
  const timeout = AbortSignal.timeout(30000)
  const signal = interrupted ? AbortSignal.any([timeout, interrupted]) : timeout
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'abele-node-update' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Update download redirect has no location.')
      url = endpoint(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Cannot download ${url}: HTTP ${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`Empty update download: ${url}`)
    const chunks: Buffer[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) return Buffer.concat(chunks)
        length += chunk.length
        if (length > 4 * 1024 * 1024) throw new Error('Update metadata/installer exceeds 4 MiB.')
        chunks.push(Buffer.from(chunk))
      }
    } finally {
      await reader.cancel()
    }
  }
  throw new Error('Too many update download redirects.')
}
function activeRuns(state: string): { run_id: string; session_id: string }[] {
  const file = join(state, 'node.sqlite')
  if (!existsSync(file)) return [] // Fresh foreground installs may have no database yet.
  // Do not instantiate NodeCore: inspecting a live owner's state must not migrate
  // the schema, reconcile processes, or take a second write owner.
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db
      .prepare("SELECT run_id, session_id FROM provider_runs WHERE state='active' ORDER BY run_id")
      .all() as { run_id: string; session_id: string }[]
  } finally {
    db.close()
  }
}
function checkRuns(state: string, force: boolean, report: UpdateReport) {
  const runs = activeRuns(state)
  report.agents.active_runs = runs
  if (!runs.length) return
  const detail = runs.map((run) => `${run.run_id} (session ${run.session_id})`).join(', ')
  if (!force)
    throw new Error(
      `Active runs: ${detail}. Wait for them to finish, or use --force to permit interruption.`
    )
}

/** Self-update only installer-owned deployments; the installer owns the transaction. */
export async function update(
  runtime: string,
  args: string[],
  progress?: (report: UpdateReport) => void
): Promise<UpdateReport> {
  const report: UpdateReport = {
    command: 'update',
    status: 'checking',
    current: null,
    target: null,
    target_kind: 'latest',
    update_available: false,
    check: false,
    force: false,
    exit_code: 0,
    prefix: null,
    state_dir: null,
    claude_path: null,
    service: null,
    agents: { admission_paused: false, admission_resumed: false, active_runs: [] },
    warnings: [],
    installer: null,
    error: null,
    next_step:
      'Inspect the error and selected release; run abele-node status and abele-node doctor before retrying.',
  }
  try {
    report.exit_code = await performUpdate(runtime, args, report, progress)
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    report.exit_code = 1
  }
  return report
}
async function performUpdate(
  runtime: string,
  args: string[],
  report: UpdateReport,
  progress?: (report: UpdateReport) => void
): Promise<number> {
  const options = parse(args)
  report.check = options.check
  report.force = options.force
  report.target_kind = options.version ? 'pinned' : 'latest'
  const notify = (status: UpdateReport['status']) => progress?.({ ...report, status })
  const root = dirname(runtime)
  if (!existsSync(join(root, '.installer-owned'))) {
    report.status = 'source'
    report.next_step =
      'Use git pull in your source checkout, then rebuild/reinstall; update made no changes.'
    return 0
  }
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const current = version(String(config.version))
  report.current = current
  const prefix = absolute(config.prefix ?? dirname(dirname(root)), 'prefix')
  const state = absolute(config.state, 'state')
  const claude = absolute(config.claude, 'claude')
  if (config.service !== 0 && config.service !== 1)
    throw new Error('Invalid installer config service.')
  report.prefix = prefix
  report.state_dir = state
  report.claude_path = claude
  report.service = config.service === 1
  if (
    realpathSync(join(prefix, 'share/abele-node')) !== realpathSync(root) ||
    readlinkSync(join(root, 'current')) !== current ||
    realpathSync(join(root, current)) !== realpathSync(runtime)
  )
    throw new Error(
      'Installer config/current/runtime mismatch; refusing to update an unknown deployment.'
    )

  const api =
    process.env.ABELE_INSTALL_API_URL ??
    'https://api.github.com/repos/dudaanton/abele-node/releases/latest'
  const releaseUrl = options.version
    ? api.replace(/\/latest\/?$/, `/tags/v${options.version}`)
    : api
  if (options.version && releaseUrl === api)
    throw new Error('ABELE_INSTALL_API_URL must end in /latest for pinned updates.')
  const release = JSON.parse((await download(releaseUrl)).toString('utf8')) as {
    tag_name?: unknown
    draft?: unknown
    prerelease?: unknown
    assets?: { name?: unknown }[]
  }
  if (typeof release.tag_name !== 'string' || release.draft || release.prerelease)
    throw new Error('Expected a stable, published GitHub release.')
  const target = version(release.tag_name)
  if (release.tag_name !== `v${target}` || (options.version && target !== options.version))
    throw new Error('Release tag differs from the requested vX.Y.Z tag.')
  const newer = compare(target, current) > 0
  report.target = target
  report.update_available = newer
  // This command upgrades only. Downgrades need explicit manual state recovery,
  // and a legacy target runtime may not implement the update admission fence.
  if (options.check || !newer) {
    report.status = options.check ? 'checked' : 'up_to_date'
    report.next_step = newer
      ? `abele-node update${options.version ? ` --version ${target}` : ''}`
      : 'abele-node status'
    return 0
  }
  notify('available')
  // Default signal termination skips finally. Abort pending downloads instead,
  // keeping interrupts on the cleanup path before we acquire the admission fence.
  const interrupted = new AbortController()
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let interruptSignal: (typeof signals)[number] | undefined
  const handlers = signals.map((signal) => {
    const handler = () => {
      interruptSignal ??= signal
      interrupted.abort(new Error(`Update interrupted by ${interruptSignal}.`))
    }
    process.on(signal, handler)
    return handler
  })
  let releaseLock: (() => void) | undefined
  let work: string | undefined
  try {
    releaseLock = acquireUpdateLock(state)
    report.agents.admission_paused = true
    checkRuns(state, options.force, report)
    notify('paused')

    if (!Array.isArray(release.assets)) throw new Error('Invalid release asset metadata.')
    const hasInstaller = release.assets.some((asset) => asset.name === 'install.sh')
    const hasSums = release.assets.some((asset) => asset.name === 'SHA256SUMS')
    let script: Buffer
    if (hasInstaller) {
      const base = (
        process.env.ABELE_INSTALL_BASE_URL ?? 'https://github.com/dudaanton/abele-node'
      ).replace(/\/$/, '')
      const tagged = `${base}/releases/download/${release.tag_name}`
      script = await download(`${tagged}/install.sh`, interrupted.signal)
      if (hasSums) {
        const sums = (await download(`${tagged}/SHA256SUMS`, interrupted.signal)).toString('utf8')
        const matches = sums
          .split(/\r?\n/)
          .map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
          .filter((match) => match?.[2] === 'install.sh')
        if (matches.length !== 1)
          throw new Error('Invalid install.sh checksum manifest: expected exactly one entry.')
        if (createHash('sha256').update(script).digest('hex') !== matches[0]![1]!.toLowerCase())
          throw new Error('install.sh SHA256 checksum mismatch; nothing was installed.')
      } else {
        report.warnings.push(
          `Release ${release.tag_name} publishes install.sh without SHA256SUMS; downloading over HTTPS without a publisher checksum.`
        )
        notify('warning')
      }
    } else {
      if (!options.version)
        throw new Error(
          `Release ${release.tag_name} has no install.sh asset. Refusing unverified latest installer; use --version ${target} to explicitly allow that tag's raw installer.`
        )
      const raw = (
        process.env.ABELE_UPDATE_RAW_URL ?? 'https://raw.githubusercontent.com/dudaanton/abele-node'
      ).replace(/\/$/, '')
      report.warnings.push(
        `Legacy release: using tag ${release.tag_name}'s raw install.sh over HTTPS without an installer checksum (explicit --version pin).`
      )
      notify('warning')
      script = await download(`${raw}/${release.tag_name}/install.sh`, interrupted.signal)
    }
    work = mkdtempSync(join(root, '.update-'))
    const file = join(work, 'install.sh')
    writeFileSync(file, script, { mode: 0o600 })
    // Defensive recheck before installer handoff, including state written by a
    // legacy runtime without the admission fence. --check never touches live state.
    checkRuns(state, options.force, report)
    const result = spawnSync(
      '/bin/sh',
      [
        file,
        '--version',
        target,
        '--prefix',
        prefix,
        '--state-dir',
        state,
        '--claude-path',
        claude,
        ...(config.service === 0 ? ['--no-service'] : []),
      ],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }
    )
    report.installer = {
      exit_code: result.status ?? 1,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
    if (result.error) throw result.error
    if (result.status !== 0) {
      const lines = report.installer.stderr.trim().split(/\r?\n/).filter(Boolean)
      const diagnostic =
        lines.find((line) => line.startsWith('abele-node:')) ??
        lines.find((line) => !line.startsWith('{'))
      report.status = 'failed'
      report.error = `Update installer failed (${result.signal ?? result.status}); ${diagnostic ? diagnostic.slice(0, 240) : 'inspect its diagnostics and retained state.'}`
      return result.status ?? 1
    }
    report.status = 'updated'
    report.next_step =
      config.service === 1 ? 'abele-node status' : 'abele-node start, then abele-node status'
    return 0
  } catch (error) {
    if (!interruptSignal) throw error
    report.status = 'interrupted'
    report.error = `Update interrupted by ${interruptSignal}.`
    report.next_step = 'Run abele-node status, then retry abele-node update when ready.'
    return { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interruptSignal]
  } finally {
    try {
      if (work) rmSync(work, { recursive: true, force: true })
    } finally {
      try {
        if (releaseLock) {
          releaseLock()
          report.agents.admission_resumed = true
        }
      } finally {
        signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!))
      }
    }
  }
}
