#!/usr/bin/env node
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
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { startDaemon, readRuntime, offlineToken } from './index.js'
import { ClaudeProviderAdapter } from '@abele/node-core'

const args = process.argv.slice(2)
function option(name: string, fallback: string) {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  if (!args[i + 1]) throw new Error('missing_' + name)
  const value = args[i + 1]!
  args.splice(i, 2)
  return value
}
const state = resolve(option('--state-dir', join(homedir(), '.local/state/abele-node')))
const port = Number(option('--port', '7777'))
const configuredWorktreeRoot = option('--worktree-root', '')
const worktreeRoot = configuredWorktreeRoot ? resolve(configuredWorktreeRoot) : undefined
const claudePath = resolve(
  option('--claude-path', process.env.ABELE_CLAUDE_PATH ?? join(homedir(), '.local/bin/claude'))
)
const claudeProfile = option('--claude-profile', 'inherited')
const claudeBudget = Number(option('--claude-budget', '0.35'))
const claudeDeadline = Number(option('--claude-deadline-ms', '120000'))
const permissionTtl = Number(option('--permission-ttl-ms', '60000'))
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
const output = (value: unknown) => console.log(JSON.stringify(value))
const label = 'dev.abele.node'
const launchDomain = `gui/${process.getuid!()}`
const launch = (...params: string[]) => spawnSync('/bin/launchctl', params, { encoding: 'utf8' })
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
async function main() {
  switch (args[0]) {
    case 'start': {
      const daemon = await startDaemon(state, port, worktreeRoot, claudeOptions)
      output({
        type: 'listening',
        pid: process.pid,
        ...{ port: daemon.port, node_id: daemon.node_id },
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
      // Disable KeepAlive before terminating; otherwise launchd immediately restarts it.
      const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist')
      const installedHere =
        existsSync(plist) &&
        readFileSync(plist, 'utf8').includes(
          '<string>--state-dir</string><string>' + escape(state) + '</string>'
        )
      if (process.platform === 'darwin' && installedHere)
        launch('bootout', `${launchDomain}/${label}`)
      const running = readRuntime(state)
      if (running) process.kill(running.pid, 'SIGTERM')
      output({ stopping: running?.pid ?? null })
      return
    }
    case 'status':
      output({ running: !!readRuntime(state), ...readRuntime(state), state_dir: state })
      return
    case 'doctor': {
      const running = readRuntime(state)
      output({
        node: process.version,
        sqlite: 'node:sqlite, WAL, foreign_keys=ON, synchronous=FULL',
        state_dir: state,
        state_mode: existsSync(state) ? (statSync(state).mode & 0o777).toString(8) : null,
        running: !!running,
        launch_agent: existsSync(join(homedir(), 'Library/LaunchAgents', label + '.plist')),
        profile: 'local-token-v1 (loopback only)',
        encrypted_at_rest: false,
        claude: running?.claude ?? new ClaudeProviderAdapter(claudeOptions).capabilities(),
      })
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
      mkdirSync(state, { recursive: true, mode: 0o700 })
      chmodSync(state, 0o700)
      const runtime = join(state, 'runtime'),
        root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
      mkdirSync(runtime, { recursive: true })
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
        if (!path.startsWith('node_modules/') || entry.dev || entry.link) continue
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
        '--state-dir',
        state,
        '--port',
        String(port),
        ...(worktreeRoot ? ['--worktree-root', worktreeRoot] : []),
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
      ]
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${command.map((v) => '<string>' + escape(v) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${escape(state)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape([dirname(process.execPath), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'))}</string><key>HOME</key><string>${escape(homedir())}</string></dict><key>StandardOutPath</key><string>${escape(join(logs, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${escape(join(logs, 'stderr.log'))}</string></dict></plist>\n`
      writeFileSync(destination, plist, { mode: 0o600 })
      chmodSync(destination, 0o600)
      const result = launch('bootstrap', launchDomain, destination)
      if (result.status !== 0) throw new Error(result.stderr || 'launchctl bootstrap failed')
      launch('kickstart', `${launchDomain}/${label}`)
      output({ installed: destination, runtime })
      return
    }
    default:
      throw new Error(
        'Usage: abele-node install|start|stop|status|doctor|token create|list|revoke [--state-dir PATH] [--port PORT] [--worktree-root PATH]'
      )
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
