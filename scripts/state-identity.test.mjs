import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'

fs.mkdirSync('.scratch', { recursive: true })
const scratch = fs.mkdtempSync(path.resolve('.scratch/state-identity-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
const helper = fs.readFileSync('scripts/service-transition.mjs', 'utf8')
// Exercise the recovery predicate itself without starting a transaction or ps.
const stateMatches = vm.runInNewContext(
  helper.slice(helper.indexOf('function stateMatches('), helper.indexOf('function physical(')) +
    '\nstateMatches',
  { fs, path, randomBytes }
)
function state(name) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir)
  return dir
}
test('recovery admits a legacy inode after a device change and creates a private marker', () => {
  const dir = state('legacy'),
    s = fs.statSync(dir, { bigint: true })
  assert.equal(stateMatches(dir, `${s.dev + 1n}:${s.ino}`), true)
  const marker = path.join(dir, '.abele-state-identity')
  assert.match(fs.readFileSync(marker, 'utf8'), /^[a-f0-9]{64}$/)
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600)
  const token = fs.readFileSync(marker, 'utf8')
  assert.equal(stateMatches(dir, `${s.dev + 1n}:${s.ino}`), true)
  assert.equal(fs.readFileSync(marker, 'utf8'), token)
})
test('recovery refuses missing or replaced marker-bound state without creating evidence', () => {
  const dir = state('replaced'),
    s = fs.statSync(dir, { bigint: true })
  assert.equal(stateMatches(dir, `marker:${s.ino}:${'a'.repeat(64)}`), false)
  assert.equal(fs.existsSync(path.join(dir, '.abele-state-identity')), false)
  assert.equal(
    stateMatches(path.join(scratch, 'missing'), `marker:${s.ino}:${'a'.repeat(64)}`),
    false
  )
  assert.equal(stateMatches(dir, `${s.dev}:${s.ino + 1n}`), false)
  assert.equal(fs.existsSync(path.join(dir, '.abele-state-identity')), false)
})
test('recovery preserves valid markers and refuses tampered or aliased markers in either format', () => {
  const dir = state('marker'),
    s = fs.statSync(dir, { bigint: true })
  const marker = path.join(dir, '.abele-state-identity'),
    token = 'a'.repeat(64)
  const recorded = `marker:${s.ino}:${token}`,
    legacy = `${s.dev + 1n}:${s.ino}`
  fs.writeFileSync(marker, token)
  assert.equal(stateMatches(dir, recorded), true)
  assert.equal(stateMatches(dir, legacy), true)
  assert.equal(fs.readFileSync(marker, 'utf8'), token)
  fs.writeFileSync(marker, 'b'.repeat(64))
  assert.equal(stateMatches(dir, recorded), false)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'b'.repeat(64))
  fs.writeFileSync(marker, 'invalid')
  assert.equal(stateMatches(dir, legacy), false)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'invalid')
  fs.unlinkSync(marker)
  const target = path.join(scratch, 'foreign-marker')
  fs.writeFileSync(target, token)
  fs.symlinkSync(target, marker)
  assert.equal(stateMatches(dir, recorded), false)
  assert.equal(stateMatches(dir, legacy), false)
  assert.equal(fs.readlinkSync(marker), target)
  assert.equal(fs.readFileSync(target, 'utf8'), token)
})
test('a live foreground owner gets the exact stop command before service manager checks', () => {
  const dir = state('foreground')
  fs.writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify({ pid: process.pid }))
  const installer = fs.readFileSync('install.sh', 'utf8')
  const start = Math.min(
    installer.indexOf('if [ "$service" = 1 ] || [ "$old_service" = 1 ]; then'),
    installer.indexOf('assert_foreground_stopped() {')
  )
  const boundary = installer.slice(start, installer.indexOf("work=''", start))
  const prefix = path.join(scratch, 'prefix with spaces')
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      `
fail() { printf '%s\\n' "$*" >&2; exit 1; }
check_dropins() { fail 'manager inspected before foreground refusal'; }
${boundary}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        node: process.execPath,
        state: dir,
        prefix,
        service: '1',
        old_service: '0',
        os: 'linux',
      },
    }
  )
  assert.equal(result.status, 1)
  assert.ok(
    result.stderr.includes("'" + path.join(prefix, 'bin/abele-node') + "' stop"),
    result.stderr
  )
  assert.doesNotMatch(result.stderr, /manager inspected/)
})
