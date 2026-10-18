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
import { spawn } from 'node:child_process'
import { type Progress, progressDue } from './update-progress.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { acquireUpdateLock } from '@abele/node-core'
import { recoverServiceTransition } from './service.js'

type Options = { version?: string; check: boolean; force: boolean }
type ActiveRun = { run_id: string; session_id: string }
export type UpdateReport = {
  stage?: string
  bytes?: number
  total?: number | null
  elapsed?: number
  command: 'update'
  status:
    | 'checking'
    | 'progress'
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
  agents: {
    admission_paused: boolean
    admission_resumed: boolean
    active_runs: ActiveRun[]
    /** Long-lived sessions that keep running while the node restarts. */
    kept_sessions?: ActiveRun[]
  }
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
        `Unknown option: ${arg}. For background operation use abele-node service enable. Usage: abele-node update [--version X.Y.Z] [--check] [--force] [--json]`
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
// Network errors, timeouts, 5xx and 429 are worth another attempt; every other answer is final.
class TransientDownloadError extends Error {
  constructor(
    message: string,
    readonly waitMs?: number
  ) {
    super(message)
  }
}
const RETRY_ATTEMPTS = 5
const RETRY_BUDGET_MS = 90000
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}
function reason(error: unknown) {
  const cause = (error as { cause?: unknown }).cause
  const message = error instanceof Error ? error.message : String(error)
  return cause instanceof Error && cause.message ? `${message} (${cause.message})` : message
}
async function download(
  value: string,
  interrupted?: AbortSignal,
  progress?: (p: Progress) => void
): Promise<Buffer> {
  const started = Date.now()
  const backoff = Number(process.env.ABELE_UPDATE_RETRY_DELAY_MS ?? 1000)
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(value, interrupted, progress)
    } catch (error) {
      if (interrupted?.aborted) throw interrupted.reason ?? error
      if (!(error instanceof TransientDownloadError)) throw error
      const wait = error.waitMs ?? backoff * 2 ** (attempt - 1)
      const elapsed = Date.now() - started
      if (attempt >= RETRY_ATTEMPTS || elapsed + wait > RETRY_BUDGET_MS)
        throw new Error(
          `${error.message}; gave up after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'} in ${Math.round(elapsed / 1000)} s${
            error.waitMs !== undefined && attempt < RETRY_ATTEMPTS
              ? ` (the server asked to wait ${Math.round(error.waitMs / 1000)} s)`
              : ''
          }. The download server may be temporarily unavailable; try again in a few minutes.`
        )
      try {
        progress?.({
          stage: `Waiting ${Math.round(wait / 1000)} s before download retry ${attempt + 1}/${RETRY_ATTEMPTS} (90 s retry budget)`,
        })
        await sleep(wait, undefined, interrupted ? { signal: interrupted } : undefined)
      } catch (abort) {
        throw interrupted?.reason ?? abort
      }
    }
  }
}
async function downloadOnce(
  value: string,
  interrupted?: AbortSignal,
  progress?: (p: Progress) => void
): Promise<Buffer> {
  let url = endpoint(value)
  const timeout = AbortSignal.timeout(30000)
  const signal = interrupted ? AbortSignal.any([timeout, interrupted]) : timeout
  // Anything that breaks the connection itself, including our own timeout, is transient.
  const network = (error: unknown) =>
    interrupted?.aborted
      ? error
      : new TransientDownloadError(`Cannot download ${url}: ${reason(error)}`)
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response: Response
    try {
      response = await fetch(url, {
        signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'abele-node-update', 'Accept-Encoding': 'identity' },
      })
    } catch (error) {
      throw network(error)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Update download redirect has no location.')
      url = endpoint(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const message = `Cannot download ${url}: HTTP ${response.status}`
      if (response.status === 429 || response.status >= 500)
        throw new TransientDownloadError(message, retryAfter(response.headers.get('retry-after')))
      throw new Error(message)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`Empty update download: ${url}`)
    const chunks: Buffer[] = []
    let length = 0
    const started = Date.now()
    const total = Number(response.headers.get('content-length')) || null
    let previousBytes = 0,
      previousTime = started
    const emit = () => {
      progress?.({
        stage: 'Downloading metadata (30 s request timeout)',
        bytes: length,
        total,
        elapsed: (Date.now() - started) / 1000,
      })
      previousBytes = length
      previousTime = Date.now()
    }
    const heartbeat = setInterval(emit, 5000)
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>
        try {
          read = await reader.read()
        } catch (error) {
          throw network(error)
        }
        if (read.done) {
          emit()
          return Buffer.concat(chunks)
        }
        length += read.value.length
        if (length > 4 * 1024 * 1024) throw new Error('Update metadata/installer exceeds 4 MiB.')
        chunks.push(Buffer.from(read.value))
        if (progressDue(length, total, Date.now(), previousBytes, previousTime)) emit()
      }
    } finally {
      clearInterval(heartbeat)
      await reader.cancel().catch(() => {})
    }
  }
  throw new Error('Too many update download redirects.')
}
function activeRuns(state: string): {
  runs: { run_id: string; session_id: string }[]
  kept: { run_id: string; session_id: string }[]
} {
  const file = join(state, 'node.sqlite')
  if (!existsSync(file)) return { runs: [], kept: [] } // Fresh foreground installs may have no database yet.
  // Do not instantiate NodeCore: inspecting a live owner's state must not migrate
  // the schema, reconcile processes, or take a second write owner.
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    // Long-lived sessions keep running through the restart; an older schema has none.
    const live = (db.prepare('PRAGMA table_info(provider_runs)').all() as { name: string }[]).some(
      (c) => c.name === 'live'
    )
    const rows = db
      .prepare(
        `SELECT run_id, session_id, ${live ? 'live IS NOT NULL' : '0'} AS kept FROM provider_runs WHERE state='active' ORDER BY run_id`
      )
      .all() as { run_id: string; session_id: string; kept: number }[]
    const strip = ({ run_id, session_id }: { run_id: string; session_id: string }) => ({
      run_id,
      session_id,
    })
    return {
      runs: rows.filter((r) => !r.kept).map(strip),
      kept: rows.filter((r) => r.kept).map(strip),
    }
  } finally {
    db.close()
  }
}
function checkRuns(state: string, force: boolean, report: UpdateReport) {
  const { runs, kept } = activeRuns(state)
  report.agents.active_runs = runs
  report.agents.kept_sessions = kept
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
  let lastProgress = Date.now()
  let stageStarted = lastProgress
  let previousStage: string | undefined
  const emit = (value: UpdateReport) => {
    lastProgress = Date.now()
    if (report.stage !== previousStage) {
      previousStage = report.stage
      stageStarted = lastProgress
    }
    progress?.(value)
  }
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgress >= 5000) {
      emit({
        ...report,
        status: 'progress',
        stage: `Waiting: ${report.stage ?? 'preparing update'} (${Math.round((Date.now() - stageStarted) / 1000)} s elapsed)`,
      })
    }
  }, 250)
  try {
    report.exit_code = await performUpdate(runtime, args, report, emit)
  } catch (error) {
    report.status = 'failed'
    report.error = `${report.stage ?? 'Preparing update'}: ${error instanceof Error ? error.message : String(error)} State and provider credentials retained; inspect installer rollback diagnostics before retrying.`
    report.exit_code = 1
  } finally {
    clearInterval(heartbeat)
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
  if (process.platform === 'darwin' && process.arch === 'x64')
    throw new Error(
      'Unsupported platform: macOS x64 (Intel or Rosetta). Use a native arm64 shell and Node.js on Apple Silicon; Intel Macs are unsupported.'
    )
  const notify = (status: UpdateReport['status']) => progress?.({ ...report, status })
  const event = (p: Progress) => {
    report.stage = p.stage
    progress?.({ ...report, status: 'progress', ...p })
  }
  const stage = (name: string) => event({ stage: name })
  const fetchProgress = (p: Progress) => progress?.({ ...report, status: 'progress', ...p })
  stage('Preparing update')
  recoverServiceTransition(runtime)
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
  stage('Checking for a release (30 s request timeout)')
  const release = JSON.parse(
    (await download(releaseUrl, undefined, fetchProgress)).toString('utf8')
  ) as {
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
    stage(`Pausing agent turns (${report.agents.kept_sessions?.length ?? 0} sessions kept alive)`)
    notify('paused')
    stage('Downloading the installer and checksums')

    if (!Array.isArray(release.assets)) throw new Error('Invalid release asset metadata.')
    const hasInstaller = release.assets.some((asset) => asset.name === 'install.sh')
    const hasSums = release.assets.some((asset) => asset.name === 'SHA256SUMS')
    let script: Buffer
    if (hasInstaller) {
      const base = (
        process.env.ABELE_INSTALL_BASE_URL ?? 'https://github.com/dudaanton/abele-node'
      ).replace(/\/$/, '')
      const tagged = `${base}/releases/download/${release.tag_name}`
      script = await download(`${tagged}/install.sh`, interrupted.signal, fetchProgress)
      if (hasSums) {
        const sums = (
          await download(`${tagged}/SHA256SUMS`, interrupted.signal, fetchProgress)
        ).toString('utf8')
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
      script = await download(
        `${raw}/${release.tag_name}/install.sh`,
        interrupted.signal,
        fetchProgress
      )
    }
    work = mkdtempSync(join(root, '.update-'))
    const file = join(work, 'install.sh')
    writeFileSync(file, script, { mode: 0o600 })
    // Defensive recheck before installer handoff, including state written by a
    // legacy runtime without the admission fence. --check never touches live state.
    checkRuns(state, options.force, report)
    const result = await new Promise<{
      status: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      error?: Error
    }>((done) => {
      stage('Starting verified installer')
      const child = spawn(
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
        {
          detached: true,
          stdio: ['inherit', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ABELE_INSTALL_PROGRESS: 'json',
            ABELE_PROGRESS_TTY: process.stdout.isTTY ? '1' : '0',
          },
        }
      )
      const abort = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, interruptSignal ?? 'SIGTERM')
          } catch {
            /* Already exited. */
          }
        }
      }
      interrupted.signal.addEventListener('abort', abort, { once: true })
      if (interrupted.signal.aborted) abort()
      let stdout = '',
        stderr = '',
        pending = ''
      child.stdout.on('data', (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-8 * 1024 * 1024)
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8 * 1024 * 1024)
        pending = (pending + data.toString()).slice(-8 * 1024 * 1024)
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('ABELE_PROGRESS ')) continue
          try {
            const p = JSON.parse(line.slice(15)) as Progress
            if (typeof p.stage === 'string') event(p)
          } catch {
            /* Keep unrecognized diagnostics in the installer report. */
          }
        }
      })
      child.on('error', (error) => {
        interrupted.signal.removeEventListener('abort', abort)
        done({ status: 1, signal: null, stdout, stderr, error })
      })
      child.on('close', (status, signal) => {
        interrupted.signal.removeEventListener('abort', abort)
        done({ status, signal, stdout, stderr })
      })
    })
    report.installer = {
      exit_code: result.status ?? 1,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
    if (interrupted.signal.aborted) throw interrupted.signal.reason
    if (result.error) throw result.error
    if (result.status !== 0) {
      const lines = report.installer.stderr.trim().split(/\r?\n/).filter(Boolean)
      const diagnostic =
        lines.find((line) => line.startsWith('abele-node:')) ??
        lines.find((line) => !line.startsWith('{') && !line.startsWith('ABELE_PROGRESS '))
      report.status = 'failed'
      report.error = `Update installer failed during ${report.stage ?? 'installer'} (${result.signal ?? result.status}); ${diagnostic ? diagnostic.slice(0, 240) : 'inspect its diagnostics and retained state.'} State and provider credentials retained; inspect rollback diagnostics before retrying.`
      return result.status ?? 1
    }
    report.status = 'updated'
    report.next_step =
      config.service === 1 ? 'abele-node status' : 'abele-node start, then abele-node status'
    return 0
  } catch (error) {
    if (!interruptSignal) throw error
    report.status = 'interrupted'
    report.error = `Update interrupted by ${interruptSignal} during ${report.stage ?? 'preparing update'}. State and provider credentials retained; inspect rollback diagnostics before retrying.`
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
