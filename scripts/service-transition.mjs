// Offline crash recovery for service-only installer transactions. No provider execution.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [action, requestedRoot, ...args] = process.argv.slice(2)
const root = fs.realpathSync(requestedRoot)
const pending = path.join(root, '.service-transition')
const lock = path.join(root, '.install-lock')
const uid = process.getuid()
const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const present = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}
function privateFile(p, directory = false) {
  const s = fs.lstatSync(p)
  if (
    s.isSymbolicLink() ||
    s.uid !== uid ||
    s.mode & (directory ? 0o077 : 0o022) ||
    (directory ? !s.isDirectory() : !s.isFile())
  )
    throw new Error('Unprotected service recovery artifact: ' + p)
}
function sync(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function write(p, value) {
  fs.writeFileSync(p, value, { mode: 0o600 })
  sync(p)
  sync(path.dirname(p))
}
function copy(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, fs.statSync(source).mode & 0o777)
  sync(destination)
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid service transaction owner')
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if (e.code === 'ESRCH') return false
    throw e
  }
}
function lockOwner(file) {
  const s = fs.lstatSync(file),
    value = s.isSymbolicLink() ? fs.readlinkSync(file) : ''
  if (s.uid !== uid || !/^service-group:[1-9]\d*$/.test(value))
    throw new Error('Unknown service lock; recovery refused')
  return Number(value.slice('service-group:'.length))
}
function identity(p) {
  const s = fs.statSync(p, { bigint: true })
  if (!s.isDirectory()) throw new Error('State is not a directory')
  return s.dev + ':' + s.ino
}
function stateMatches(p, expected) {
  try {
    const s = fs.statSync(p, { bigint: true })
    if (!s.isDirectory()) return false
    const legacy = /^\d+:\d+$/.test(expected)
    if (legacy) {
      if (String(s.ino) !== expected.split(':')[1]) return false
    } else if (
      !/^marker:\d+:[a-f0-9]{64}$/.test(expected) ||
      String(s.ino) !== expected.split(':')[1]
    )
      return false
    const marker = path.join(p, '.abele-state-identity')
    // Only legacy records may acquire a marker. A missing marker for a new
    // identity is evidence of replacement, never permission to adopt it.
    if (legacy) {
      try {
        fs.writeFileSync(marker, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    }
    const m = fs.lstatSync(marker)
    if (!m.isFile() || m.isSymbolicLink()) return false
    const token = fs.readFileSync(marker, 'utf8')
    return /^[a-f0-9]{64}$/.test(token) && (legacy || expected === `marker:${s.ino}:${token}`)
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(e.code)) return false
    throw e
  }
}
function physical(p) {
  const tail = []
  let current = path.resolve(p)
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail)
    } catch (e) {
      if (e.code !== 'ENOENT' || present(current)) throw e
      tail.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}
function run(command, argv) {
  const r = spawnSync(command, argv, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (r.error || r.status !== 0)
    throw new Error((r.stderr || r.error?.message || r.stdout || command + ' failed').trim())
  return r.stdout.trim()
}
function processGroup(pid) {
  const value = run('/bin/ps', ['-o', 'pgid=', '-p', String(pid)])
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Cannot verify service process group')
  return Number(value)
}
function quiescentGroup(pgid, kind) {
  const rows = run('/bin/ps', ['-axo', 'pid=,pgid=,stat=']).split('\n')
  const members = rows
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/)
      if (!match) throw new Error('Cannot enumerate service process group')
      return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3] }
    })
    .filter((p) => p.pgid === pgid && !p.state.startsWith('Z'))
  if (alive(pgid) || members.length)
    throw new Error(
      `Another ${kind} is active; process group ${pgid} is still active. Wait for all mutation children to exit.`
    )
}
// Recovery's own manager/write children need the same isolation as the installer.
if (action === 'recover' && processGroup(process.pid) !== process.pid) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { detached: true, stdio: 'inherit' }
  )
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  process.exit(status ?? 1)
}
function linkIdentity(file) {
  const s = fs.lstatSync(file, { bigint: true })
  if (!s.isSymbolicLink() || s.uid !== BigInt(uid))
    throw new Error('Unprotected service recovery lock')
  return s.dev + ':' + s.ino
}
function ownsLink(file, token, inode) {
  return present(file) && linkIdentity(file) === inode && fs.readlinkSync(file) === token
}
function acquireRecoveryLock(file) {
  // The canonical symlink is published only after its immutable owner directory
  // is complete. Rename claims one stale generation; losers never unlink it.
  const own = fs.mkdtempSync(path.join(root, '.service-recovery-owner.')),
    token = path.basename(own)
  write(
    path.join(own, 'owner.json'),
    JSON.stringify({ pid: process.pid, pgid: process.pid, token })
  )
  let inode,
    claimed = ''
  try {
    try {
      fs.symlinkSync(token, file)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const observed = linkIdentity(file),
        stale = fs.readlinkSync(file)
      if (!/^\.service-recovery-owner\.[A-Za-z0-9]+$/.test(stale))
        throw new Error('Unknown recovery lock generation; inspect the retained lock')
      let source = path.join(root, stale)
      if (!present(source)) {
        const prefix = stale + '.claimed-'
        const claims = fs
          .readdirSync(root)
          .filter((name) => name.startsWith(prefix) && present(path.join(root, name, 'owner.json')))
        if (claims.length !== 1)
          throw new Error('Another service recovery takeover is in progress; retry')
        const claimant = claims[0].slice(prefix.length).match(/^([1-9]\d*)-[A-Za-z0-9]+$/)?.[1]
        if (!claimant) throw new Error('Unknown recovery takeover owner')
        quiescentGroup(Number(claimant), 'service recovery takeover')
        source = path.join(root, claims[0])
      }
      privateFile(source, true)
      privateFile(path.join(source, 'owner.json'))
      const previous = JSON.parse(fs.readFileSync(path.join(source, 'owner.json'), 'utf8'))
      if (previous.token !== stale || previous.pid !== previous.pgid)
        throw new Error('Invalid recovery owner record')
      quiescentGroup(previous.pgid, 'service recovery')
      claimed = fs.mkdtempSync(path.join(root, stale + '.claimed-' + process.pid + '-'))
      fs.renameSync(source, claimed) // Atomic generation claim; only one contender succeeds.
      sync(root)
      if (!ownsLink(file, stale, observed)) throw new Error('Recovery lock changed during takeover')
      fs.unlinkSync(file) // Exclusively claimed, quiescent generation, not another owner.
      fs.symlinkSync(token, file) // A fresh contender may win this gap; EEXIST is a refusal.
    }
    inode = linkIdentity(file)
    sync(root)
    if (claimed) {
      fs.rmSync(claimed, { recursive: true })
      claimed = ''
    }
  } catch (error) {
    // Keep a claimed generation if it is still the canonical lock's recovery
    // evidence. A later attempt can atomically claim this dead claimant's directory.
    if (!present(file) || fs.readlinkSync(file) !== token) fs.rmSync(own, { recursive: true })
    throw error
  }
  return () => {
    if (ownsLink(file, token, inode)) fs.unlinkSync(file)
    if (!present(file) || fs.readlinkSync(file) !== token) fs.rmSync(own, { recursive: true })
    sync(root)
  }
}
function wait(check, message) {
  const until = Date.now() + 45000
  do {
    if (check()) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  } while (Date.now() < until)
  throw new Error(message)
}
function matches(p, snapshot) {
  if (!present(p) || !present(snapshot)) return false
  const s = fs.lstatSync(p)
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    s.uid === uid &&
    (s.mode & 0o777) === (fs.statSync(snapshot).mode & 0o777) &&
    digest(p) === digest(snapshot)
  )
}
function restore(destination, snapshot, candidate) {
  privateFile(snapshot)
  if (matches(destination, snapshot)) return
  privateFile(candidate)
  if (!matches(candidate, snapshot)) throw new Error('Recovery candidate changed: ' + candidate)
  fs.renameSync(candidate, destination)
  sync(path.dirname(destination))
}

privateFile(path.join(root, '.installer-owned'))

if (action === 'prepare') {
  const [work, backup, serviceFile, state, stateIdentity, oldService, oldVersion, pid, os, home] =
    args
  const temporary = path.join(work, 'service-transition')
  fs.mkdirSync(temporary, { mode: 0o700 })
  for (const [name, file] of [
    ['config', path.join(root, 'config.json')],
    ['wrapper', path.join(path.dirname(path.dirname(root)), 'bin/abele-node')],
  ]) {
    if (present(file)) {
      copy(file, path.join(temporary, 'previous-' + name))
      copy(file, path.join(temporary, 'restore-' + name))
    }
  }
  const meta = {
    root,
    rootIdentity: identity(root),
    work: fs.realpathSync(work),
    workIdentity: identity(work),
    backup: backup ? fs.realpathSync(backup) : '',
    backupIdentity: backup ? identity(backup) : '',
    serviceFile: physical(serviceFile),
    state,
    stateIdentity,
    oldService: Number(oldService),
    oldVersion,
    pid: Number(pid),
    pgid: Number(pid),
    os,
    home: fs.realpathSync(home),
  }
  write(path.join(temporary, 'transaction.json'), JSON.stringify(meta) + '\n')
  sync(temporary)
  fs.renameSync(temporary, pending)
  sync(root)
} else if (action === 'commit') {
  privateFile(pending, true)
  for (const file of [
    path.join(root, 'config.json'),
    path.join(path.dirname(path.dirname(root)), 'bin/abele-node'),
  ]) {
    sync(file)
    sync(path.dirname(file))
  }
  const meta = JSON.parse(fs.readFileSync(path.join(pending, 'transaction.json'), 'utf8'))
  if (present(meta.serviceFile)) sync(meta.serviceFile)
  if (present(path.dirname(meta.serviceFile))) sync(path.dirname(meta.serviceFile))
  write(path.join(pending, 'committed'), 'committed\n')
} else if (action === 'finish') {
  if (present(pending)) {
    privateFile(pending, true)
    // Atomic retirement prevents SIGKILL during recursive cleanup from exposing
    // a half-deleted active transaction on the next invocation.
    const retired = fs.mkdtempSync(path.join(root, '.service-transition-retired.'))
    fs.renameSync(pending, retired)
    sync(root)
    fs.rmSync(retired, { recursive: true })
    sync(root)
  }
} else if (action === 'recover') {
  if (!present(pending)) {
    if (present(lock) && fs.lstatSync(lock).isSymbolicLink()) {
      quiescentGroup(lockOwner(lock), 'service transition')
      // Before transaction publication there are no service mutations to undo.
      fs.unlinkSync(lock)
      sync(root)
    }
    process.exit(0)
  }
  privateFile(pending, true)
  privateFile(path.join(pending, 'transaction.json'))
  const m = JSON.parse(fs.readFileSync(path.join(pending, 'transaction.json'), 'utf8'))
  if (
    m.root !== root ||
    m.rootIdentity !== identity(root) ||
    !['darwin', 'linux'].includes(m.os) ||
    !['0', '1'].includes(String(m.oldService)) ||
    !/^\d+\.\d+\.\d+$/.test(m.oldVersion) ||
    m.pgid !== m.pid
  )
    throw new Error('Invalid service recovery metadata')
  quiescentGroup(m.pgid, 'service transition')
  const recoveryLock = path.join(root, '.service-recovery-lock')
  const releaseRecovery = acquireRecoveryLock(recoveryLock)
  try {
    if (present(lock) && lockOwner(lock) !== m.pid)
      throw new Error('Service install lock was replaced')
    if (!present(lock) && !present(path.join(pending, 'committed')))
      throw new Error('Service install lock disappeared')
    const verifyBoundary = () => {
      if (
        fs.realpathSync(root) !== root ||
        identity(root) !== m.rootIdentity ||
        physical(m.state) !== m.state ||
        !stateMatches(m.state, m.stateIdentity)
      )
        throw new Error('Installed state/root identity changed; recovery refused')
    }
    verifyBoundary()
    if (fs.readlinkSync(path.join(root, 'current')) !== m.oldVersion)
      throw new Error('Current runtime changed; recovery refused')
    const expected = physical(
      path.join(
        m.home,
        m.os === 'darwin'
          ? 'Library/LaunchAgents/dev.abele.node.plist'
          : '.config/systemd/user/abele-node.service'
      )
    )
    if (expected !== m.serviceFile) throw new Error('Service path changed; recovery refused')
    if (
      path.dirname(m.work) !== root ||
      !path.basename(m.work).startsWith('.download.') ||
      (present(m.work) && fs.realpathSync(m.work) !== m.work)
    )
      throw new Error('Invalid recovery journal directory')
    const previous = path.join(pending, 'previous-config'),
      config = path.join(root, 'config.json'),
      wrapper = path.join(path.dirname(path.dirname(root)), 'bin/abele-node')
    privateFile(previous)
    const old = JSON.parse(fs.readFileSync(previous, 'utf8'))
    if (
      old.version !== m.oldVersion ||
      old.state !== m.state ||
      (old.state_identity !== m.stateIdentity &&
        !(/^\d+:\d+$/.test(old.state_identity) && stateMatches(m.state, old.state_identity))) ||
      old.service !== m.oldService
    )
      throw new Error('Recovery snapshot differs from recorded installation')
    for (const [name, file] of [
      ['config', config],
      ['wrapper', wrapper],
    ]) {
      if (
        !matches(file, path.join(pending, 'previous-' + name)) &&
        !matches(file, path.join(pending, 'next-' + name))
      )
        throw new Error('Published ' + name + ' changed; recovery refused')
    }
    const finish = () => {
      if (present(m.work)) {
        privateFile(m.work, true)
        if (identity(m.work) !== m.workIdentity) throw new Error('Recovery work directory replaced')
        fs.rmSync(m.work, { recursive: true })
      }
      if (m.backup && present(m.backup)) {
        if (
          path.dirname(m.backup) !== path.dirname(m.serviceFile) ||
          !path.basename(m.backup).startsWith('.abele-node-backup.')
        )
          throw new Error('Invalid service backup path')
        privateFile(m.backup, true)
        if (identity(m.backup) !== m.backupIdentity)
          throw new Error('Service backup directory replaced')
        fs.rmSync(m.backup, { recursive: true })
      }
      const retired = fs.mkdtempSync(path.join(root, '.service-transition-retired.'))
      // Release the original install lock while the recovery mutex and pending
      // record still exclude new installers. Never remove a newly published lock.
      if (present(lock)) {
        if (lockOwner(lock) !== m.pid) throw new Error('Service install lock was replaced')
        fs.unlinkSync(lock)
      }
      fs.renameSync(pending, retired)
      sync(root)
      fs.rmSync(retired, { recursive: true })
      sync(root)
    }
    if (present(path.join(pending, 'committed'))) {
      console.error('Recovering interrupted service transition cleanup; state is retained.')
      finish()
    } else {
      privateFile(m.work, true)
      if (identity(m.work) !== m.workIdentity) throw new Error('Recovery work directory replaced')
      const journal = path.join(m.work, 'actions.jsonl')
      privateFile(journal)
      const text = fs.readFileSync(journal, 'utf8'),
        lines = text.split('\n'),
        intents = []
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue
        let entry
        try {
          entry = JSON.parse(lines[i])
        } catch (e) {
          if (i === lines.length - 1 && !text.endsWith('\n')) break
          throw e
        }
        if (entry.phase !== 'intent') continue
        if (
          entry.state !== m.state ||
          entry.stateIdentity !== m.stateIdentity ||
          ![
            'stopped-service',
            'retained-state',
            'write-service',
            'reloaded-service',
            'enabled-service',
            'disabled-service',
            'started-service',
            'published-config',
            'published-wrapper',
          ].includes(entry.action)
        )
          throw new Error('Unexpected service recovery intent')
        const target =
          entry.action === 'published-config'
            ? config
            : entry.action === 'published-wrapper'
              ? wrapper
              : entry.action === 'retained-state'
                ? m.state
                : m.serviceFile
        if (physical(entry.target) !== physical(target))
          throw new Error('Recovery intent target changed')
        intents.push(entry.action)
      }
      const has = (name) => intents.includes(name),
        next = path.join(pending, 'next-service')
      let original = ''
      if (m.oldService === 1) {
        if (
          !m.backup ||
          path.dirname(m.backup) !== path.dirname(m.serviceFile) ||
          !path.basename(m.backup).startsWith('.abele-node-backup.')
        )
          throw new Error('Invalid service backup path')
        privateFile(m.backup, true)
        if (identity(m.backup) !== m.backupIdentity)
          throw new Error('Service backup directory replaced')
        original = path.join(m.backup, 'previous-service')
        privateFile(original)
        if (digest(original) !== old.service_sha256 || physical(old.service_file) !== m.serviceFile)
          throw new Error('Service backup differs from recorded fingerprint')
      }
      if (present(m.serviceFile)) {
        if (!matches(m.serviceFile, next) && !(original && matches(m.serviceFile, original)))
          throw new Error('Service file changed; recovery refused')
      } else if (m.oldService === 1 && !has('write-service'))
        throw new Error('Owned service disappeared without a journaled removal')
      const cli = path.join(root, m.oldVersion, 'packages/node-daemon/dist/cli.js')
      const report = (command = 'status') =>
        JSON.parse(
          run(process.execPath, [
            cli,
            command,
            '--json',
            '--state-dir',
            m.state,
            '--claude-path',
            old.claude,
            ...(old.codex_enabled === false ? ['--no-codex'] : []),
          ])
        )
      const ownedRuntime = (r) =>
        r.runtime?.version === m.oldVersion &&
        r.runtime?.cli_path &&
        fs.realpathSync(r.runtime.cli_path) === fs.realpathSync(cli) &&
        r.state_dir === m.state
      const system = (...argv) => {
        verifyBoundary()
        return run('systemctl', ['--user', ...argv])
      }
      const property = (name) =>
        system('show', 'abele-node.service', '--property=' + name, '--value')
      const job = 'gui/' + uid + '/dev.abele.node'
      const launch = (...argv) => {
        verifyBoundary()
        return spawnSync('/bin/launchctl', argv, { encoding: 'utf8', timeout: 1000 })
      }
      const missing = (r) =>
        (r.status === 3 || r.status === 113) &&
        /could not find (?:specified )?service|no such process/i.test(r.stderr || '')
      const plistArgs = (file) => {
        const array = fs
          .readFileSync(file, 'utf8')
          .match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1]
        if (!array) throw new Error('Unknown recovery plist arguments')
        return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) =>
          x[1]
            .replaceAll('&quot;', '"')
            .replaceAll('&apos;', "'")
            .replaceAll('&gt;', '>')
            .replaceAll('&lt;', '<')
            .replaceAll('&amp;', '&')
        )
      }
      const loadedArgs = (r) => {
        const body = r.stdout.match(/\n[ \t]*arguments = \{\r?\n([\s\S]*?)\r?\n[ \t]*\}/)?.[1]
        if (!body) throw new Error('Unknown cached launch arguments')
        const lines = body.split(/\r?\n/),
          indent = lines[0].match(/^[ \t]+/)?.[0]
        if (!indent || lines.some((line) => !line.startsWith(indent)))
          throw new Error('Unknown cached launch arguments')
        return lines.map((line) => line.slice(indent.length))
      }
      function inspectMac() {
        const r = launch('print', job)
        if (missing(r)) return false
        if (r.status !== 0) throw new Error('Cannot inspect launchd during recovery')
        const actual = JSON.stringify(loadedArgs(r))
        if (
          ![next, original]
            .filter((p) => p && present(p))
            .some((p) => JSON.stringify(plistArgs(p)) === actual)
        )
          throw new Error('Foreign cached launchd job; recovery refused')
        return true
      }
      function inspectLinux() {
        const paths = JSON.parse(
          run('busctl', [
            '--user',
            '--json=short',
            'get-property',
            'org.freedesktop.systemd1',
            '/org/freedesktop/systemd1',
            'org.freedesktop.systemd1.Manager',
            'UnitPath',
          ])
        )
        if (
          paths.type !== 'as' ||
          !Array.isArray(paths.data) ||
          paths.data.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
        )
          throw new Error('Invalid systemd UnitPath')
        const env = process.env,
          list = (v, fallback) => (v || fallback).split(':').filter(Boolean)
        const runtime = env.XDG_RUNTIME_DIR || '/run/user/' + uid
        const roots = new Set([
          path.dirname(m.serviceFile),
          ...paths.data,
          path.join(env.XDG_CONFIG_HOME || m.home + '/.config', 'systemd/user'),
          path.join(env.XDG_CONFIG_HOME || m.home + '/.config', 'systemd/user.control'),
          path.join(env.XDG_DATA_HOME || m.home + '/.local/share', 'systemd/user'),
          ...[
            'user',
            'user.control',
            'transient',
            'generator.early',
            'generator',
            'generator.late',
          ].map((n) => path.join(runtime, 'systemd', n)),
          '/etc/systemd/user',
          '/run/systemd/user',
          '/usr/local/lib/systemd/user',
          '/usr/lib/systemd/user',
          '/lib/systemd/user',
          ...list(env.XDG_CONFIG_DIRS, '/etc/xdg').map((p) => path.join(p, 'systemd/user')),
          ...list(env.XDG_DATA_DIRS, '/usr/local/share:/usr/share').map((p) =>
            path.join(p, 'systemd/user')
          ),
          ...list(env.SYSTEMD_UNIT_PATH, ''),
        ])
        for (const dir of roots) {
          if (!path.isAbsolute(dir))
            throw new Error('Non-absolute systemd search path; recovery refused')
          for (const name of ['service.d', 'abele-.service.d', 'abele-node.service.d']) {
            const p = path.join(dir, name)
            if (present(p) && fs.readdirSync(p).some((n) => n.endsWith('.conf')))
              throw new Error('Unmanaged systemd drop-ins; recovery refused')
          }
        }
        if (property('DropInPaths'))
          throw new Error('Unmanaged loaded systemd drop-ins; recovery refused')
        const fragment = property('FragmentPath')
        if (fragment && physical(fragment) !== m.serviceFile)
          throw new Error('Foreign systemd fragment; recovery refused')
        const pid = property('MainPID')
        if (!/^\d+$/.test(pid)) throw new Error('Unknown systemd PID')
        if (pid !== '0') {
          const r = report()
          if (!r.running || String(r.pid) !== pid || !ownedRuntime(r))
            throw new Error('Systemd PID does not belong to recorded runtime/state')
        }
        return pid !== '0' || !['inactive', 'failed'].includes(property('ActiveState'))
      }
      console.error('Recovering interrupted service transition; state is retained.')
      if (!present(path.join(pending, 'committed'))) {
        // Stop only a journaled manager start, never a foreground daemon in state.
        if (has('started-service')) {
          if (m.os === 'darwin') {
            if (inspectMac()) {
              const before = report()
              if (before.running && !ownedRuntime(before))
                throw new Error('Unowned daemon in service state')
              launch('bootout', job)
              wait(() => {
                const r = report()
                return (
                  missing(launch('print', job)) &&
                  (!before.running || !r.running || r.pid !== before.pid)
                )
              }, 'Recovery launchd stop unconfirmed')
            }
          } else if (inspectLinux()) {
            system('stop', 'abele-node.service')
            wait(
              () =>
                property('MainPID') === '0' &&
                ['inactive', 'failed'].includes(property('ActiveState')),
              'Recovery systemd stop unconfirmed'
            )
          }
        }
        if (has('write-service')) {
          verifyBoundary()
          if (
            present(m.serviceFile) &&
            !matches(m.serviceFile, next) &&
            !(original && matches(m.serviceFile, original))
          )
            throw new Error('Service file changed during recovery')
          if (m.oldService === 1)
            restore(m.serviceFile, original, path.join(m.backup, 'restore-candidate'))
          else if (present(m.serviceFile)) fs.unlinkSync(m.serviceFile)
          if (m.os === 'linux') {
            inspectLinux()
            system('daemon-reload')
          }
        }
        if (m.os === 'linux' && has('enabled-service')) system('disable', 'abele-node.service')
        if (m.os === 'linux' && has('disabled-service')) system('enable', 'abele-node.service')
        for (const [name, file] of [
          ['config', config],
          ['wrapper', wrapper],
        ])
          if (has('published-' + name)) {
            verifyBoundary()
            if (
              !matches(file, path.join(pending, 'previous-' + name)) &&
              !matches(file, path.join(pending, 'next-' + name))
            )
              throw new Error('Published ' + name + ' changed during recovery')
            restore(
              file,
              path.join(pending, 'previous-' + name),
              path.join(pending, 'restore-' + name)
            )
          }
        if (has('stopped-service')) {
          if (m.os === 'darwin') {
            if (!inspectMac()) {
              launch('bootstrap', 'gui/' + uid, m.serviceFile)
              wait(() => inspectMac(), 'Recovery launchd load unconfirmed')
            }
            launch('kickstart', job)
          } else {
            inspectLinux()
            system('daemon-reload')
            inspectLinux()
            system('enable', 'abele-node.service')
            system('restart', 'abele-node.service')
          }
          wait(() => {
            const r = report()
            return r.running && ownedRuntime(r)
          }, 'Previous service health unconfirmed after recovery')
          const doctor = report('doctor')
          if (!doctor.running || !ownedRuntime(doctor))
            throw new Error('Previous service doctor check failed')
        }
        // A durable completion marker also makes recovery itself resumable.
        verifyBoundary()
        if (present(m.serviceFile)) sync(m.serviceFile)
        if (present(path.dirname(m.serviceFile))) sync(path.dirname(m.serviceFile))
        write(path.join(pending, 'committed'), 'recovered\n')
      }
      finish()
    }
  } finally {
    releaseRecovery()
  }
} else throw new Error('Unknown service transaction operation')
