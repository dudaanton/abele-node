#!/usr/bin/env node
import {
  retainServiceArguments,
  validateServiceFlags,
  serviceFlagLimits,
  summarizeServiceFlags,
} from './service-arguments.js'
import './warnings.js'
import { DatabaseSync } from 'node:sqlite'
import { humanOutput, humanError, errorMessage } from './output.js'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import {
  encodePairCode,
  PairingListEntrySchema,
  shortPairingFingerprint,
  InviteSchema,
} from '@abele/node-protocol'
import { selectPendingPairing } from './paired.js'
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
import {
  startDaemon,
  readRuntime,
  offlineToken,
  control,
  PairedListenerSchema,
  type PairedListenerConfig,
} from './index.js'
import { FileServeOwnershipStore, TailscaleServeManager, tailscaleRunner } from './tailscale.js'
import { update } from './update.js'
import {
  changeService,
  installedService,
  serviceStatus,
  showServiceFlags,
  installationMode,
  stageServiceCandidate,
  recoverServiceTransition,
  protectedPairedConfig,
  recordedPairedConfig,
} from './service.js'
import { cliHelp, requestedHelp } from './cli-help.js'
import { doctorCodex } from '@abele/provider-codex'
import {
  ClaudeProviderAdapter,
  PiProviderAdapter,
  CodexProviderAdapter,
  AcpProviderAdapter,
  canonicalStateDir,
  installLsp,
  lspStatus,
  popularLsp,
  installJsAdapter,
} from '@abele/node-core'

const json = process.argv.includes('--json')
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json')
  const help = requestedHelp(args)
  if (help) {
    console.log(help)
    return
  }
  const serviceFlags: Record<string, string> = {}
  if (args[0] === 'service' && args[1] === 'flags' && args[2] === 'set') {
    const globals = new Set([
      '--state-dir',
      '--runtime-dir',
      '--claude-path',
      '--tailscale-path',
      '--no-codex',
    ])
    for (const arg of args.slice(3))
      if (arg.startsWith('--') && !(arg in serviceFlagLimits) && !globals.has(arg))
        throw new Error('Unsupported service flag: ' + arg)
    // Capture before the ordinary start options consume these same names.
    for (let i = 3; i < args.length; i++) {
      const flag = args[i]!
      if (!(flag in serviceFlagLimits)) continue
      if (flag in serviceFlags) throw new Error('Duplicate service flag: ' + flag)
      serviceFlags[flag] = args[i + 1] ?? ''
      args.splice(i--, 2)
    }
    if (!Object.keys(serviceFlags).length)
      throw new Error('Supply at least one service flag; see abele-node service --help.')
    validateServiceFlags(serviceFlags)
  }
  function option(name: string, fallback: string, repeatable = false) {
    const i = args.indexOf(name)
    if (i < 0) return fallback
    if (!args[i + 1]) throw new Error('missing_' + name)
    const value = args[i + 1]!
    args.splice(i, 2)
    // Operator arguments precede wrapper defaults. Keep the first value, but
    // consume every appended default before interpreting command positionals.
    if (!repeatable) {
      for (let next = args.indexOf(name); next >= 0; next = args.indexOf(name)) {
        if (!args[next + 1] || args[next + 1]!.startsWith('--')) throw new Error('missing_' + name)
        args.splice(next, 2)
      }
    }
    return value
  }
  function flag(name: string) {
    const present = args.includes(name)
    for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) args.splice(i, 1)
    return present
  }
  const state = canonicalStateDir(option('--state-dir', join(homedir(), '.local/state/abele-node')))
  const port = Number(option('--port', '7777'))
  // A release installer can use its already deployed, immutable runtime directly.
  const configuredRuntime = option('--runtime-dir', '')
  const installerJournal = option('--installer-journal', '')
  // Only the generated manager command bypasses the interactive start guard.
  const serviceRun = flag('--service-run')
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
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
  const explicitPairedConfig = option('--paired-config', '')
  const noPairedConfig = flag('--no-paired-config')
  if (noPairedConfig && explicitPairedConfig)
    throw new Error('Choose either --paired-config PATH or --no-paired-config.')
  // An installer deployment records its paired configuration; the service's own
  // command line and the operator's commands both read that one file.
  const recordedPaired =
    explicitPairedConfig || noPairedConfig ? undefined : recordedPairedConfig(runtimeRoot, state)
  let pairedLoaded: { value: PairedListenerConfig | undefined } | undefined
  /**
   * Parsed on first use. Diagnostics (`report`) tolerate a broken recorded file, so
   * status, doctor and `service enable --no-paired-config` still work; serving
   * and pairing refuse it.
   */
  const loadPairedConfig = (report = false): PairedListenerConfig | undefined => {
    if (!pairedLoaded) {
      if (explicitPairedConfig)
        pairedLoaded = {
          value: PairedListenerSchema.parse(
            JSON.parse(readFileSync(resolve(explicitPairedConfig), 'utf8'))
          ),
        }
      else if (recordedPaired) {
        try {
          pairedLoaded = { value: protectedPairedConfig(recordedPaired).config }
        } catch (error) {
          if (report) return undefined
          throw error
        }
      } else pairedLoaded = { value: undefined }
    }
    return pairedLoaded.value
  }
  const tailscalePath = option(
    '--tailscale-path',
    process.env.ABELE_TAILSCALE_PATH ?? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  )
  const pairInstallation = option('--pair-installation', '')
  const nodeName = option('--node-name', hostname())
  const policyVerified = flag('--tailnet-policy-verified')
  // Read-only here: doctor and status consult the daemon's ownership record.
  const tailscale = new TailscaleServeManager(
    tailscaleRunner(tailscalePath),
    new FileServeOwnershipStore(join(state, 'serve-ownership.json'))
  )
  const configuredWorktreeRoot = option('--worktree-root', '')
  const worktreeRoot = configuredWorktreeRoot ? resolve(configuredWorktreeRoot) : undefined
  const claudePath = resolve(
    option('--claude-path', process.env.ABELE_CLAUDE_PATH ?? join(homedir(), '.local/bin/claude'))
  )
  const claudeProfile = option('--claude-profile', 'inherited')
  const claudeBudget = Number(option('--claude-budget', '0.35'))
  const claudeDeadline = Number(option('--claude-deadline-ms', '1800000'))
  const permissionTtl = Number(option('--permission-ttl-ms', '60000'))
  const sessionModel = option('--claude-session-model', '')
  const sessionEffort = option('--claude-session-effort', '')
  const sessionPermissionMode = option('--claude-session-permission-mode', '')
  const sessionPermissionTtl = option('--claude-session-permission-ttl-ms', '')
  const claudeIdle = option('--claude-idle-ms', '')
  const claudeMaxLive = option('--claude-max-live', '')
  const claudeDetached = option('--claude-detached-ms', '')
  const allowBypass = flag('--claude-allow-bypass')
  const noLive = flag('--no-claude-live')
  const noPiLive = flag('--no-pi-live')
  const accountArgs: string[] = []
  for (
    let value = option('--claude-account', '', true);
    value;
    value = option('--claude-account', '', true)
  )
    accountArgs.push(value)
  const claudeAccounts: Record<string, string> = {}
  for (const entry of accountArgs) {
    const at = entry.indexOf('=')
    if (at < 1) throw new Error('invalid_claude_account: use NAME=CONFIG_DIR')
    claudeAccounts[entry.slice(0, at)] = resolve(entry.slice(at + 1))
  }
  const liveOptions = {
    ...(claudeIdle ? { idleMs: Number(claudeIdle) } : {}),
    ...(claudeMaxLive ? { maxLive: Number(claudeMaxLive) } : {}),
  }
  if (
    (claudeIdle && (!Number.isSafeInteger(Number(claudeIdle)) || Number(claudeIdle) < 0)) ||
    (claudeMaxLive &&
      (!Number.isSafeInteger(Number(claudeMaxLive)) ||
        Number(claudeMaxLive) < 1 ||
        Number(claudeMaxLive) > 64))
  )
    throw new Error('invalid_claude_configuration')
  // Authorized debugger infrastructure, and the JS profile once its pinned adapter is installed.
  const debuggerEnabled = flag('--debugger')
  flag('--codex')
  const noCodex = flag('--no-codex')
  const codexPath = option('--codex-path', process.env.ABELE_CODEX_PATH ?? '')
  const codexModel = option('--codex-model', process.env.ABELE_CODEX_MODEL ?? '')
  const codexHome = option('--codex-home', process.env.ABELE_CODEX_HOME ?? '')
  const codexOptions = {
    allowBypass,
    enabled: !noCodex,
    ...(codexPath ? { executable: codexPath } : {}),
    model: codexModel,
    ...(codexHome ? { home: resolve(codexHome) } : {}),
    permissionTtlMs: permissionTtl,
  }
  const piProvider = option('--pi-provider', '')
  const piModel = option('--pi-model', '')
  const piAgentDir = resolve(option('--pi-agent-dir', join(homedir(), '.pi/agent')))
  const piProfile = option('--pi-profile', 'inherited')
  const piDeadline = Number(option('--pi-deadline-ms', '1800000'))
  const piMaxTokens = Number(option('--pi-max-tokens', '32768'))
  if (!['inherited', 'isolated'].includes(piProfile)) throw new Error('invalid_pi_configuration')
  const piOptions = {
    agentDir: piAgentDir,
    provider: piProvider,
    model: piModel,
    profile: piProfile as 'inherited' | 'isolated',
    maxTokens: piMaxTokens,
    deadlineMs: piDeadline,
    permissionTtlMs: permissionTtl,
    // Owner sessions share the operator's long-lived session choices with Claude's.
    live: !noPiLive,
    allowBypass,
    ...(sessionPermissionTtl ? { sessionPermissionTtlMs: Number(sessionPermissionTtl) } : {}),
    ...(claudeDetached ? { detachedMs: Number(claudeDetached) } : {}),
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
    live: !noLive,
    allowBypass,
    accounts: claudeAccounts,
    ...(sessionModel ? { sessionModel } : {}),
    ...(sessionEffort ? { sessionEffort } : {}),
    ...(sessionPermissionMode ? { sessionPermissionMode } : {}),
    ...(sessionPermissionTtl ? { sessionPermissionTtlMs: Number(sessionPermissionTtl) } : {}),
    ...(claudeDetached ? { detachedMs: Number(claudeDetached) } : {}),
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port')
  // Consume shared options before dispatching any subcommand, including LSP.
  if (args[0] === 'lsp') {
    if (args[1] === 'status' && args.length === 2) {
      const rows = await lspStatus(state, process.cwd())
      console.log(
        json
          ? JSON.stringify(rows)
          : rows
              .map(
                (row) =>
                  `${row.language}: ${row.found ? `${row.server} (${row.version ?? 'version not checked'})` : 'missing'}${row.diagnostic ? `; ${row.diagnostic}` : ''}${row.project_eslint ? `; project ESLint: ${row.project_eslint}` : ''}`
              )
              .join('\n')
      )
    } else if (args[1] === 'install') {
      const requested = args.slice(2)
      const languages =
        !requested.length || (requested.length === 1 && requested[0] === '--popular')
          ? popularLsp
          : requested
      const rows = await installLsp(state, languages)
      console.log(
        json
          ? JSON.stringify(rows)
          : rows.map((row) => `${row.language}: ${row.message}`).join('\n')
      )
    } else throw new Error('usage: abele-node lsp status [--json] | install [lang…|--popular]')
    return
  }
  const version = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  ).version as string
  const commandOptions: Record<string, string[]> = {
    update: ['--check', '--force', '--version'],
    'approve-pair': ['--list', '--installation-id', '--fingerprint'],
  }
  for (const arg of args.slice(args[0] === '--version' ? 1 : 0)) {
    if (
      args[0] !== 'update' &&
      arg.startsWith('-') &&
      !(commandOptions[args[0] ?? ''] ?? []).includes(arg)
    )
      throw new Error(
        `Unknown option: ${arg}. For background operation use abele-node service enable; run abele-node --help.`
      )
  }
  if (
    ['start', 'stop', 'status', 'doctor', 'install', 'version', '--version'].includes(
      args[0] ?? ''
    ) &&
    args.length !== 1
  )
    throw new Error(cliHelp(args[0] === '--version' ? 'version' : args[0]))
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
    case 'debugger':
      if (args.length !== 3 || args[1] !== 'install' || args[2] !== 'js')
        throw new Error('Usage: abele-node debugger install js [--state-dir PATH]')
      output(await installJsAdapter(state))
      return
    case '--version':
    case 'version':
      console.log(version)
      return
    case 'update': {
      const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
      let inline = false
      const report = await update(runtime, args.slice(1), (progress) => {
        if (json) console.error(JSON.stringify(progress))
        else {
          const nextInline = !!process.stdout.isTTY && progress.bytes !== undefined
          if (inline && !nextInline) process.stdout.write('\n')
          process.stdout.write(
            `${nextInline ? '\r\u001b[2K' : ''}${humanOutput(['update'], progress)}${nextInline ? '' : '\n'}`
          )
          inline = nextInline
        }
      })
      const rendered = json ? JSON.stringify(report) : humanOutput(['update'], report)
      if (inline) process.stdout.write('\n')
      if (json || report.exit_code === 0) console.log(rendered)
      else console.error(rendered)
      process.exitCode = report.exit_code
      return
    }
    case 'service': {
      if (args[1] === 'flags') {
        if (args.length !== 3 || !['show', 'set'].includes(args[2]!))
          throw new Error(
            'Usage: abele-node service flags show|set [--allow-bypass on|off] [--pi-max-tokens N] [--permission-ttl-ms N] [--pi-deadline-ms N] [--json]'
          )
        if (args[2] === 'show') {
          const flags = showServiceFlags(runtimeRoot, state)
          console.log(json ? JSON.stringify({ flags }) : summarizeServiceFlags(flags))
        } else
          output(
            await changeService(runtimeRoot, state, 'enable', undefined, undefined, serviceFlags)
          )
        return
      }
      if (args[1] === 'debugger') {
        if (args.length !== 3 || !['on', 'off', 'adopt'].includes(args[2]!))
          throw new Error('Usage: abele-node service debugger on|off|adopt [--json]')
        if (explicitPairedConfig || noPairedConfig)
          throw new Error('Paired configuration options apply only to service enable.')
        output(
          await changeService(
            runtimeRoot,
            state,
            args[2] === 'adopt' ? 'adopt-debugger' : 'enable',
            undefined,
            args[2] === 'adopt' ? undefined : args[2] === 'on'
          )
        )
        return
      }
      if (args.length !== 2 || !['enable', 'disable', 'status'].includes(args[1]!))
        throw new Error('Usage: abele-node service enable|disable|status [--json]')
      const paired = explicitPairedConfig || (noPairedConfig ? null : undefined)
      if (args[1] === 'status' && paired !== undefined)
        throw new Error('--paired-config and --no-paired-config apply only to service enable.')
      output(
        args[1] === 'status'
          ? serviceStatus(runtimeRoot, state)
          : await changeService(runtimeRoot, state, args[1]!, paired)
      )
      return
    }
    case 'start': {
      if (!json && !serviceRun)
        console.error(
          installationMode(runtimeRoot, state) === 'service'
            ? 'Starting the configured background service; checking its state…'
            : 'Starting AbeleNode in the foreground; Ctrl-C stops it. For background operation: abele-node service enable.'
        )
      if (!serviceRun && installedService(runtimeRoot, state)?.service === 1) {
        const report = await changeService(runtimeRoot, state, 'enable')
        if (json) output(report)
        else console.log(humanOutput(['service', 'status'], report))
        return
      }
      const daemon = await startDaemon(
        state,
        port,
        worktreeRoot,
        claudeOptions,
        loadPairedConfig(),
        tailscalePath,
        piOptions,
        codexOptions,
        { enabled: debuggerEnabled },
        liveOptions
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
      // The installer's journaled stop runs inside the live transition; public
      // invocations recover an orphan first, before manager/process mutations.
      if (!process.env.ABELE_SERVICE_TRANSITION) recoverServiceTransition(runtimeRoot)
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
      const paired = running?.paired ?? loadPairedConfig(true)
      // Discovery metadata is local-only; keep the existing status JSON field set stable.
      const publicRuntime = { ...running }
      delete publicRuntime.node_name
      const report = {
        running: !!running,
        mode: installationMode(runtimeRoot, state),
        service: serviceStatus(runtimeRoot, state),
        ...publicRuntime,
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
        service: serviceStatus(runtimeRoot, state),
        profile: 'local-token-v1 (loopback only)',
        paired: running?.paired ?? loadPairedConfig(true) ?? null,
        tailscale: await tailscale.doctor(
          (running?.paired ?? loadPairedConfig(true))?.endpoint,
          (running?.paired ?? loadPairedConfig(true))?.backend_port,
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
        acp: new AcpProviderAdapter({ stateDir: state }).capabilities(),
      })
      return
    }
    case 'pair': {
      const action = args[1],
        installation_id = args[2]
      if (!action) {
        const endpoint = (readRuntime(state)?.paired ?? loadPairedConfig())?.endpoint
        if (!endpoint)
          throw new Error(
            'paired_config_required: configure a paired WSS endpoint before issuing a code; run abele-node doctor'
          )
        const invite = InviteSchema.parse(
          await offlineToken(state, {
            action: 'pairing.issue',
            endpoint,
            label: 'device',
            ...(pairInstallation ? { installation_id: pairInstallation } : {}),
          })
        )
        const code = encodePairCode({ version: 1, node_name: nodeName, invite })
        if (json) output({ code, node_name: nodeName, invite })
        else {
          console.log(code)
          console.error(
            'Paste this code into Connect node in Abele. Keep it private. Approve the waiting device with abele-node approve-pair.'
          )
        }
      } else if (action === 'routes') {
        if (args.length !== 2) throw new Error('Usage: pair routes [--json]')
        const paired = readRuntime(state)?.paired ?? loadPairedConfig()
        if (!paired) throw new Error('paired_config_required')
        output({ endpoint: paired.endpoint, accepted_routes: paired.accepted_routes ?? [] })
      } else if (action === 'invite') {
        const endpoint = (readRuntime(state)?.paired ?? loadPairedConfig())?.endpoint
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
    case 'approve-pair': {
      const installationId = option('--installation-id', '') || undefined
      const expectedFingerprint = option('--fingerprint', '') || undefined
      const listIndex = args.indexOf('--list')
      const listOnly = listIndex >= 0
      if (listOnly) args.splice(listIndex, 1)
      if (args.length > 2 || (listOnly && (args[1] || installationId || expectedFingerprint)))
        throw new Error(
          'Usage: approve-pair [NAME] [--installation-id ID] [--fingerprint FULL] | --list [--json]'
        )
      const entries = PairingListEntrySchema.array()
        .parse(await offlineToken(state, { action: 'pairing.list' }))
        .filter((entry) => entry.state === 'pending')
      const listing = humanOutput(['approve-pair', '--list'], entries)
      if (listOnly) {
        output(entries)
        return
      }
      let selected
      if (args[1] || installationId) {
        try {
          selected = selectPendingPairing(entries, args[1], installationId)
        } catch (error) {
          console.error(listing)
          throw error
        }
      } else {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
          console.error(listing)
          throw new Error('selection_required')
        }
        console.error(listing)
        if (!entries.length) return
        const prompt = createInterface({ input: process.stdin, output: process.stderr })
        try {
          const answer = (
            await prompt.question('Choose a device by name or number (empty to cancel): ')
          ).trim()
          if (!answer) return
          const number = /^\d+$/.test(answer) ? Number(answer) : 0
          selected =
            number > 0 && number <= entries.length
              ? selectPendingPairing(entries, undefined, entries[number - 1]!.installation_id)
              : selectPendingPairing(entries, answer)
          const yes = (
            await prompt.question(
              `Approve ${JSON.stringify(selected.device_name)} (${shortPairingFingerprint(selected.fingerprint)})? [y/N] `
            )
          ).trim()
          if (!/^y(es)?$/i.test(yes)) return
        } finally {
          prompt.close()
        }
      }
      if (expectedFingerprint && expectedFingerprint !== selected.fingerprint)
        throw new Error('key_mismatch')
      output(
        await offlineToken(state, {
          action: 'pairing.approve',
          installation_id: selected.installation_id,
          device_fingerprint: selected.fingerprint,
        })
      )
      return
    }
    case 'recover-worktree-deletion': {
      if (args.length > 3)
        throw new Error('Usage: recover-worktree-deletion [OPERATION_ID] [INSTALLATION_ID]')
      output(
        await offlineToken(state, {
          action: 'worktree.recover',
          ...(args[1] ? { operation_id: args[1] } : {}),
          ...(args[2] ? { installation_id: args[2] } : {}),
        })
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
      // --runtime-dir is the installer's internal, journaled LaunchAgent writer.
      if (!configuredRuntime && installedService(runtimeRoot, state)) {
        console.error(
          'abele-node install is deprecated for installer deployments; use abele-node service enable. Recorded provider settings are retained; use install.sh to change them.'
        )
        const report = await changeService(runtimeRoot, state, 'enable')
        if (json) output(report)
        else console.log(humanOutput(['service', 'enable'], report))
        return
      }
      if (!configuredRuntime)
        console.error(
          'abele-node install is the legacy manual macOS setup. For installer deployments use abele-node service enable.'
        )
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
      let command = [
        process.execPath,
        join(runtime, 'packages/node-daemon/dist/cli.js'),
        'start',
        '--json',
        '--state-dir',
        state,
        '--service-run',
        '--port',
        String(port),
        ...(worktreeRoot ? ['--worktree-root', worktreeRoot] : []),
        // The installer always says which paired configuration the service gets.
        ...(explicitPairedConfig ? ['--paired-config', resolve(explicitPairedConfig)] : []),
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
        ...(sessionModel ? ['--claude-session-model', sessionModel] : []),
        ...(sessionEffort ? ['--claude-session-effort', sessionEffort] : []),
        ...(sessionPermissionMode
          ? ['--claude-session-permission-mode', sessionPermissionMode]
          : []),
        ...(sessionPermissionTtl
          ? ['--claude-session-permission-ttl-ms', sessionPermissionTtl]
          : []),
        ...Object.entries(claudeAccounts).flatMap(([name, dir]) => [
          '--claude-account',
          `${name}=${dir}`,
        ]),
        ...(claudeIdle ? ['--claude-idle-ms', claudeIdle] : []),
        ...(claudeMaxLive ? ['--claude-max-live', claudeMaxLive] : []),
        ...(claudeDetached ? ['--claude-detached-ms', claudeDetached] : []),
        ...(noLive ? ['--no-claude-live'] : []),
        ...(noPiLive ? ['--no-pi-live'] : []),
        ...(allowBypass ? ['--claude-allow-bypass'] : []),
        ...(debuggerEnabled ? ['--debugger'] : []),
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
      if (process.env.ABELE_PREVIOUS_SERVICE_FILE)
        command = retainServiceArguments(
          command,
          readFileSync(process.env.ABELE_PREVIOUS_SERVICE_FILE, 'utf8'),
          'darwin',
          JSON.parse(process.env.ABELE_SERVICE_ARGUMENT_OVERRIDES ?? '{}')
        )
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
        stageServiceCandidate(runtimeRoot, candidate)
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
      throw new Error(cliHelp())
  }
}
void main().catch((error) => {
  console.error(json ? errorMessage(error) : humanError(error))
  process.exitCode = 1
})
