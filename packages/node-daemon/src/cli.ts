#!/usr/bin/env node
import './warnings.js'
import { DatabaseSync } from 'node:sqlite'
import { humanOutput, humanError } from './output.js'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  cpSync,
  readdirSync,
  existsSync,
  statSync,
  realpathSync,
  accessSync,
  constants,
  mkdtempSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { daemonProcessPresent, waitForLaunch } from './launch-wait.js'
import { startDaemon, readRuntime, offlineToken, control, PairedListenerSchema } from './index.js'
import { TailscaleServeManager, tailscaleRunner } from './tailscale.js'
import { update } from './update.js'
import { doctorCodex } from '@abele/provider-codex'
import {
  ClaudeProviderAdapter,
  PiProviderAdapter,
  CodexProviderAdapter,
  canonicalStateDir,
} from '@abele/node-core'

const json = process.argv.includes('--json')
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json')
  function option(name: string, fallback: string) {
    const i = args.indexOf(name)
    if (i < 0) return fallback
    if (!args[i + 1]) throw new Error('missing_' + name)
    const value = args[i + 1]!
    args.splice(i, 2)
    return value
  }
  const state = canonicalStateDir(option('--state-dir', join(homedir(), '.local/state/abele-node')))
  const port = Number(option('--port', '7777'))
  // A release installer can use its already deployed, immutable runtime directly.
  const configuredRuntime = option('--runtime-dir', '')
  const installerJournal = option('--installer-journal', '')
  function completedInstallerAction(action: string, target: string) {
    if (!installerJournal) return
    if (resolve(installerJournal) !== installerJournal) throw new Error('invalid_installer_journal')
    const parent = statSync(dirname(installerJournal))
    if (parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0)
      throw new Error('unprotected_installer_journal')
    writeFileSync(installerJournal, JSON.stringify({ action, target, state }) + '\n', {
      flag: 'a',
      mode: 0o600,
    })
    const fd = openSync(installerJournal, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  const pairedConfigPath = option('--paired-config', '')
  const pairedConfig = pairedConfigPath
    ? PairedListenerSchema.parse(JSON.parse(readFileSync(resolve(pairedConfigPath), 'utf8')))
    : undefined
  const tailscalePath = option(
    '--tailscale-path',
    process.env.ABELE_TAILSCALE_PATH ?? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  )
  const pairInstallation = option('--pair-installation', '')
  const policyFlag = args.indexOf('--tailnet-policy-verified')
  const policyVerified = policyFlag >= 0
  if (policyVerified) args.splice(policyFlag, 1)
  const tailscale = new TailscaleServeManager(tailscaleRunner(tailscalePath))
  const configuredWorktreeRoot = option('--worktree-root', '')
  const worktreeRoot = configuredWorktreeRoot ? resolve(configuredWorktreeRoot) : undefined
  const claudePath = resolve(
    option('--claude-path', process.env.ABELE_CLAUDE_PATH ?? join(homedir(), '.local/bin/claude'))
  )
  const claudeProfile = option('--claude-profile', 'inherited')
  const claudeBudget = Number(option('--claude-budget', '0.35'))
  const claudeDeadline = Number(option('--claude-deadline-ms', '120000'))
  const permissionTtl = Number(option('--permission-ttl-ms', '60000'))
  const codexFlag = args.indexOf('--codex')
  if (codexFlag >= 0) args.splice(codexFlag, 1)
  const noCodexFlag = args.indexOf('--no-codex')
  if (noCodexFlag >= 0) args.splice(noCodexFlag, 1)
  const codexPath = option('--codex-path', process.env.ABELE_CODEX_PATH ?? '')
  const codexModel = option('--codex-model', process.env.ABELE_CODEX_MODEL ?? '')
  const codexHome = option('--codex-home', process.env.ABELE_CODEX_HOME ?? '')
  const codexOptions = {
    enabled: noCodexFlag < 0,
    ...(codexPath ? { executable: codexPath } : {}),
    model: codexModel,
    ...(codexHome ? { home: resolve(codexHome) } : {}),
    permissionTtlMs: permissionTtl,
  }
  const piProvider = option('--pi-provider', '')
  const piModel = option('--pi-model', '')
  const piAgentDir = resolve(option('--pi-agent-dir', join(homedir(), '.pi/agent')))
  const piProfile = option('--pi-profile', 'inherited')
  const piDeadline = Number(option('--pi-deadline-ms', '120000'))
  const piMaxTokens = Number(option('--pi-max-tokens', '4096'))
  if (!['inherited', 'isolated'].includes(piProfile)) throw new Error('invalid_pi_configuration')
  const piOptions = {
    agentDir: piAgentDir,
    provider: piProvider,
    model: piModel,
    profile: piProfile as 'inherited' | 'isolated',
    maxTokens: piMaxTokens,
    deadlineMs: piDeadline,
    permissionTtlMs: permissionTtl,
  }
  if (
    !['inherited', 'isolated'].includes(claudeProfile) ||
    !Number.isFinite(claudeBudget) ||
    claudeBudget <= 0 ||
    claudeBudget > 10 ||
    !Number.isSafeInteger(claudeDeadline) ||
    claudeDeadline < 1000 ||
    claudeDeadline > 1800000 ||
    !Number.isSafeInteger(permissionTtl) ||
    permissionTtl < 1 ||
    permissionTtl > 3600000
  )
    throw new Error('invalid_claude_configuration')
  const claudeOptions = {
    executable: claudePath,
    profile: claudeProfile as 'inherited' | 'isolated',
    budgetUsd: claudeBudget,
    deadlineMs: claudeDeadline,
    permissionTtlMs: permissionTtl,
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port')
  const version = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  ).version as string
  const output = (value: unknown) =>
    console.log(
      json
        ? JSON.stringify(value)
        : humanOutput(args, value, {
            port:
              args[0] === 'token' && args[1] === 'create'
                ? (readRuntime(state)?.port ?? port)
                : undefined,
          })
    )
  const label = 'dev.abele.node'
  const launchDomain = `gui/${process.getuid!()}`
  const launch = (...params: string[]) =>
    spawnSync('/bin/launchctl', params, { encoding: 'utf8', timeout: 1000 })
  const escape = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  function plistArguments(text: string): string[] {
    const array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1]
    if (!array) return []
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
      match[1]!
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&')
    )
  }
  function launchMissing(result: ReturnType<typeof launch>): boolean {
    return (
      (result.status === 3 || result.status === 113) &&
      /could not find (?:specified )?service|no such process/i.test(result.stderr ?? '')
    )
  }
  function loadedArguments(text: string): string[] | undefined {
    const body = text.match(/\n[ \t]*arguments = \{\r?\n([\s\S]*?)\r?\n[ \t]*\}/)?.[1]
    if (!body) return
    const lines = body.split(/\r?\n/),
      indent = lines[0]!.match(/^[ \t]+/)?.[0]
    if (!indent || lines.some((line) => !line.startsWith(indent))) return
    return lines.map((line) => line.slice(indent.length))
  }
  switch (args[0]) {
    case '--version':
    case 'version':
      console.log(version)
      return
    case 'update': {
      const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
      const report = await update(
        runtime,
        args.slice(1),
        json ? undefined : (progress) => console.log(humanOutput(['update'], progress))
      )
      const rendered = json ? JSON.stringify(report) : humanOutput(['update'], report)
      if (json || report.exit_code === 0) console.log(rendered)
      else console.error(rendered)
      process.exitCode = report.exit_code
      return
    }
    case 'start': {
      const daemon = await startDaemon(
        state,
        port,
        worktreeRoot,
        claudeOptions,
        pairedConfig,
        tailscalePath,
        piOptions,
        codexOptions
      )
      output({
        type: 'listening',
        pid: process.pid,
        ...{ port: daemon.port, paired_port: daemon.paired_port, node_id: daemon.node_id },
      })
      let stopping = false
      const stop = () => {
        if (stopping) return
        stopping = true
        void daemon.stop().then(
          () => process.exit(0),
          () => process.exit(1)
        )
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
      return
    }
    case 'stop': {
      // Capture before bootout: launchd can remove the job before its daemon exits.
      let recordedPid: number | undefined
      let recordedEntry = fileURLToPath(import.meta.url)
      try {
        const record = JSON.parse(readFileSync(join(state, 'daemon.lock'), 'utf8'))
        const pid = record.pid
        if (Number.isSafeInteger(pid) && pid > 0) recordedPid = pid
        if (
          typeof record.runtime?.cli_path === 'string' &&
          record.runtime.cli_path.endsWith('/packages/node-daemon/dist/cli.js')
        )
          recordedEntry = record.runtime.cli_path
      } catch {
        /* No recorded daemon. */
      }
      const recordedPresent = () =>
        recordedPid !== undefined && daemonProcessPresent(recordedPid, recordedEntry, state)
      // Disable KeepAlive before terminating; otherwise launchd immediately restarts it.
      const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist')
      const expected =
        process.platform === 'darwin' && existsSync(plist)
          ? plistArguments(readFileSync(plist, 'utf8'))
          : []
      const stateIndex = expected.indexOf('--state-dir')
      let installedHere = stateIndex >= 0 && expected[stateIndex + 1] === state
      if (!installedHere && stateIndex >= 0) {
        try {
          const recorded = statSync(canonicalStateDir(expected[stateIndex + 1]!), {
            bigint: true,
          })
          const requested = statSync(state, { bigint: true })
          installedHere =
            recorded.isDirectory() &&
            requested.isDirectory() &&
            recorded.dev === requested.dev &&
            recorded.ino === requested.ino
        } catch {
          /* A missing or retargeted state is not proof of service ownership. */
        }
      }
      // launchd executes the plist's spelling, which may use a symlinked runtime.
      if (installedHere && expected[1]) recordedEntry = expected[1]
      let service_unloaded: boolean | null = process.platform === 'darwin' ? false : null
      if (process.platform === 'darwin' && installedHere) {
        const job = `${launchDomain}/${label}`
        const before = launch('print', job)
        if (before.status === 0) {
          // A cached job may differ from the on-disk plist. Never boot out a
          // foreign runtime merely because the file now looks like ours.
          if (JSON.stringify(loadedArguments(before.stdout)) !== JSON.stringify(expected))
            throw new Error('launch_agent_loaded_arguments_mismatch')
          const result = launch('bootout', job)
          // Journal an accepted unload immediately so rollback can restart it
          // even if process-exit confirmation subsequently times out.
          if (result.status === 0) completedInstallerAction('stopped-service', plist)
          let last = result
          await waitForLaunch(
            () => {
              last = launch('print', job)
              return launchMissing(last) && !recordedPresent()
            },
            () =>
              `launch_agent_stop_unconfirmed: ${last.stderr || last.stdout || result.stderr}; recorded pid=${recordedPid ?? 'none'}`
          )
          if (result.status !== 0) completedInstallerAction('stopped-service', plist)
        } else if (!launchMissing(before)) throw new Error('launch_agent_stop_unconfirmed')
        else if (recordedPid !== undefined && recordedPresent()) {
          try {
            process.kill(recordedPid, 'SIGTERM')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        await waitForLaunch(
          () => !recordedPresent(),
          () => 'launch_agent_stop_unconfirmed: recorded daemon pid still present'
        )
        service_unloaded = true
      }
      const running = recordedPresent() ? readRuntime(state) : undefined
      if (running && daemonProcessPresent(running.pid, recordedEntry, state)) {
        try {
          process.kill(running.pid, 'SIGTERM')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      output({ stopping: running?.pid ?? null, service_unloaded })
      return
    }
    case 'status': {
      const running = readRuntime(state)
      const paired = running?.paired ?? pairedConfig
      const report = {
        running: !!running,
        ...running,
        state_dir: state,
        claude: running?.claude ?? new ClaudeProviderAdapter(claudeOptions).capabilities(),
        tailscale: await tailscale.doctor(
          paired?.endpoint,
          paired?.backend_port,
          running?.port ?? port
        ),
      }
      if (json) output(report)
      else {
        let counts: { projects: number | null; workspaces: number | null } = {
          projects: 0,
          workspaces: 0,
        }
        let nodeId = running?.node_id
        const database = join(state, 'node.sqlite')
        if (existsSync(database)) {
          let db: DatabaseSync | undefined
          try {
            db = new DatabaseSync(database, { readOnly: true })
            db.exec('BEGIN') // Read identity and counts from one consistent snapshot.
            counts = {
              projects: Number(
                db.prepare('SELECT count(*) AS n FROM projects WHERE registered=1').get()!.n
              ),
              workspaces: Number(
                db.prepare("SELECT count(*) AS n FROM workspaces WHERE state!='removed'").get()!.n
              ),
            }
            nodeId ??= db.prepare("SELECT value FROM meta WHERE key='node_id'").get()?.value as
              string | undefined
          } catch {
            counts = { projects: null, workspaces: null }
          } finally {
            db?.close()
          }
        }
        output({
          ...report,
          version: running?.runtime?.version ?? version,
          port: running?.port ?? port,
          node_id: nodeId ?? (existsSync(database) ? 'unknown' : undefined),
          paired: paired ?? null,
          pi:
            running?.pi ?? new PiProviderAdapter({ ...piOptions, stateDir: state }).capabilities(),
          codex:
            running?.codex ??
            new CodexProviderAdapter({ ...codexOptions, stateDir: state }).capabilities(),
          ...counts,
        })
      }
      return
    }
    case 'doctor': {
      const running = readRuntime(state)
      output({
        node: process.version,
        sqlite: 'node:sqlite, WAL, foreign_keys=ON, synchronous=FULL',
        state_dir: state,
        state_mode: existsSync(state) ? (statSync(state).mode & 0o777).toString(8) : null,
        running: !!running,
        runtime: running?.runtime ?? null,
        launch_agent: existsSync(join(homedir(), 'Library/LaunchAgents', label + '.plist')),
        profile: 'local-token-v1 (loopback only)',
        paired: running?.paired ?? pairedConfig ?? null,
        tailscale: await tailscale.doctor(
          (running?.paired ?? pairedConfig)?.endpoint,
          (running?.paired ?? pairedConfig)?.backend_port,
          running?.port ?? port
        ),
        encrypted_at_rest: false,
        claude: running?.claude ?? new ClaudeProviderAdapter(claudeOptions).capabilities(),
        pi: running?.pi ?? new PiProviderAdapter({ ...piOptions, stateDir: state }).capabilities(),
        // A running daemon must recheck its own selection/environment so a login
        // followed by doctor also updates readiness, not just a standalone report.
        codex: codexOptions.enabled
          ? running?.control_socket
            ? await control(state, { action: 'codex.preflight' })
            : await doctorCodex({
                ...(codexPath ? { executable: codexPath } : {}),
                stateDir: state,
                model: codexModel || undefined,
                ...(codexHome ? { home: resolve(codexHome) } : {}),
              })
          : new CodexProviderAdapter({ ...codexOptions, stateDir: state }).capabilities(),
      })
      return
    }
    case 'pair': {
      const action = args[1],
        installation_id = args[2]
      if (action === 'invite') {
        const endpoint = (readRuntime(state)?.paired ?? pairedConfig)?.endpoint
        if (!endpoint) throw new Error('paired_config_required')
        output(
          await offlineToken(state, {
            action: 'pairing.issue',
            endpoint,
            label: args[2] ?? 'device',
            ...(pairInstallation ? { installation_id: pairInstallation } : {}),
          })
        )
      } else if (action === 'list' || action === 'rotate')
        output(
          await offlineToken(state, {
            action: action === 'list' ? 'pairing.list' : 'pairing.rotate',
          })
        )
      else if (action === 'confirm' && installation_id && args[3])
        output(
          await offlineToken(state, {
            action: 'pairing.confirm',
            installation_id,
            device_fingerprint: args[3],
          })
        )
      else if (action === 'revoke' && installation_id)
        output(await offlineToken(state, { action: 'pairing.revoke', installation_id }))
      else
        throw new Error(
          'Usage: pair invite LABEL | list | confirm INSTALLATION_ID FINGERPRINT | revoke INSTALLATION_ID | rotate'
        )
      return
    }
    case 'serve': {
      if (!readRuntime(state)) throw new Error('running_paired_daemon_required')
      if (args[1] === 'enable' && policyVerified)
        output(await control(state, { action: 'tailscale.enable', policy_verified: true }))
      else if (args[1] === 'disable') output(await control(state, { action: 'tailscale.disable' }))
      else throw new Error('Usage: serve enable --tailnet-policy-verified | disable')
      return
    }
    case 'token': {
      const action = args[1]
      if (!action || !['create', 'list', 'revoke'].includes(action))
        throw new Error('Usage: token create LABEL | list | revoke INSTALLATION_ID')
      output(await offlineToken(state, { action, value: args[2] }))
      return
    }
    case 'install': {
      if (process.platform !== 'darwin') throw new Error('LaunchAgent requires macOS')
      if (port === 0) throw new Error('install_requires_fixed_port')
      if (readRuntime(state)) throw new Error('stop_before_install')
      const existingJob = launch('print', `${launchDomain}/${label}`)
      if (existingJob.status === 0) throw new Error('stop_loaded_launch_agent_before_install')
      if (!launchMissing(existingJob)) throw new Error('launch_agent_state_unconfirmed')
      mkdirSync(state, { recursive: true, mode: 0o700 })
      chmodSync(state, 0o700)
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
      const runtime = configuredRuntime ? resolve(configuredRuntime) : join(state, 'runtime')
      if (configuredRuntime && realpathSync(runtime) !== realpathSync(root))
        throw new Error('runtime_dir_must_match_cli')
      if (!configuredRuntime) {
        mkdirSync(runtime, { recursive: true })
        cpSync(join(root, 'package.json'), join(runtime, 'package.json'))
        // Stable deployment path: the source checkout may be removed after installation.
        for (const name of readdirSync(join(root, 'packages'))) {
          const source = join(root, 'packages', name),
            destination = join(runtime, 'packages', name)
          mkdirSync(destination, { recursive: true })
          cpSync(join(source, 'package.json'), join(destination, 'package.json'))
          cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true })
        }
        const modules = join(runtime, 'node_modules')
        mkdirSync(modules, { recursive: true })
        const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
          packages: Record<string, { dev?: boolean; link?: boolean }>
        }
        for (const [path, entry] of Object.entries(lock.packages)) {
          if (
            !path.startsWith('node_modules/') ||
            entry.dev ||
            entry.link ||
            !existsSync(join(root, path)) // Optional dependencies for other platforms are absent.
          )
            continue
          const destination = join(runtime, path)
          mkdirSync(dirname(destination), { recursive: true })
          cpSync(join(root, path), destination, { recursive: true, dereference: true })
        }
        for (const name of readdirSync(join(root, 'packages'))) {
          const destination = join(modules, '@abele', name)
          mkdirSync(destination, { recursive: true })
          cpSync(join(runtime, 'packages', name, 'package.json'), join(destination, 'package.json'))
          cpSync(join(runtime, 'packages', name, 'dist'), join(destination, 'dist'), {
            recursive: true,
          })
        }
      }
      const logs = join(state, 'logs')
      mkdirSync(logs, { recursive: true, mode: 0o700 })
      chmodSync(logs, 0o700)
      for (const file of ['stdout.log', 'stderr.log']) {
        writeFileSync(join(logs, file), '', { flag: 'a', mode: 0o600 })
        chmodSync(join(logs, file), 0o600)
      }
      const destination = join(homedir(), 'Library/LaunchAgents', label + '.plist')
      mkdirSync(dirname(destination), { recursive: true })
      const command = [
        process.execPath,
        join(runtime, 'packages/node-daemon/dist/cli.js'),
        'start',
        '--json',
        '--state-dir',
        state,
        '--port',
        String(port),
        ...(worktreeRoot ? ['--worktree-root', worktreeRoot] : []),
        ...(pairedConfigPath ? ['--paired-config', resolve(pairedConfigPath)] : []),
        '--tailscale-path',
        tailscalePath,
        '--claude-path',
        claudePath,
        '--claude-profile',
        claudeProfile,
        '--claude-budget',
        String(claudeBudget),
        '--claude-deadline-ms',
        String(claudeDeadline),
        '--permission-ttl-ms',
        String(permissionTtl),
        ...(!codexOptions.enabled ? ['--no-codex'] : []),
        ...(codexPath ? ['--codex-path', codexPath] : []),
        ...(codexModel ? ['--codex-model', codexModel] : []),
        ...(codexHome ? ['--codex-home', resolve(codexHome)] : []),
        ...(piProvider ? ['--pi-provider', piProvider] : []),
        ...(piModel ? ['--pi-model', piModel] : []),
        '--pi-agent-dir',
        piAgentDir,
        '--pi-profile',
        piProfile,
        '--pi-deadline-ms',
        String(piDeadline),
        '--pi-max-tokens',
        String(piMaxTokens),
      ]
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${command.map((v) => '<string>' + escape(v) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${escape(state)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape([...(codexPath ? [dirname(codexPath)] : []), dirname(claudePath), dirname(process.execPath), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'))}</string><key>HOME</key><string>${escape(homedir())}</string>${process.env.CODEX_HOME ? `<key>CODEX_HOME</key><string>${escape(resolve(process.env.CODEX_HOME))}</string>` : ''}</dict><key>StandardOutPath</key><string>${escape(join(logs, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${escape(join(logs, 'stderr.log'))}</string></dict></plist>\n`
      if (existsSync(destination)) accessSync(destination, constants.W_OK)
      const temporary = mkdtempSync(join(dirname(destination), '.abele-plist-write-'))
      try {
        const candidate = join(temporary, 'agent.plist')
        writeFileSync(candidate, plist, { mode: 0o600 })
        const fd = openSync(candidate, constants.O_RDONLY)
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(candidate, destination)
        completedInstallerAction('write-service', destination)
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
      const result = launch('bootstrap', launchDomain, destination)
      if (result.status === 0) completedInstallerAction('started-service', destination)
      let last = result
      const job = `${launchDomain}/${label}`
      await waitForLaunch(
        () => {
          last = launch('print', job)
          return (
            last.status === 0 &&
            JSON.stringify(loadedArguments(last.stdout)) === JSON.stringify(command)
          )
        },
        () => `launch_agent_load_unconfirmed: ${last.stderr || last.stdout || result.stderr}`
      )
      if (result.status !== 0) completedInstallerAction('started-service', destination)
      const started = launch('kickstart', job)
      await waitForLaunch(
        () => {
          last = launch('print', job)
          return (
            last.status === 0 &&
            JSON.stringify(loadedArguments(last.stdout)) === JSON.stringify(command) &&
            !!readRuntime(state)
          )
        },
        () => `launch_agent_start_unconfirmed: ${last.stderr || last.stdout || started.stderr}`
      )
      output({ installed: destination, runtime })
      return
    }
    default:
      throw new Error(
        'Usage: abele-node --version|version|install|start|stop|status|doctor|token create|list|revoke [--state-dir PATH] [--port PORT] [--worktree-root PATH]\n       abele-node update [--version X.Y.Z] [--check] [--force] [--json]'
      )
  }
}
void main().catch((error) => {
  console.error(json ? (error instanceof Error ? error.message : String(error)) : humanError(error))
  process.exitCode = 1
})
