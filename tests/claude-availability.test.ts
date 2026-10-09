import { expect, afterAll } from 'vitest'
import { processIt as it } from './process-test.js'
import { processStepDeadlineMs } from '../scripts/process-test-budget.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { ClaudeProviderAdapter } from '../packages/provider-claude/src/index.js'
const flags =
  '--include-partial-messages --forward-subagent-text --resume --setting-sources --max-budget-usd'
const directories: string[] = []
function temporary(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}
afterAll(() => directories.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function fake(version: string, help = flags, status = 0) {
  const executable = join(temporary('availability-'), 'claude')
  writeFileSync(
    executable,
    `#!${process.execPath}\nif(process.argv.includes('--version')) console.log(${JSON.stringify(version)}); else { console.log(${JSON.stringify(help)}); process.exit(${status}); }\n`
  )
  chmodSync(executable, 0o700)
  return new ClaudeProviderAdapter({ executable })
}
it('accepts compatible untested versions and labels their evidence', () => {
  for (const version of ['2.1.286', '2.1.292', '2.2.0', '2.99.999']) {
    const provider = fake(version)
    expect(provider.available).toBe(true)
    expect(provider.diagnostic).toContain('untested version, flags detected')
    expect(provider.capabilities().capabilities.permissions.reason).toContain(
      'untested version, flags detected'
    )
  }
  expect(fake('2.1.291').capabilities().capabilities.permissions.evidence).toContain('real-2.1.291')
  expect(fake('2.1.285').available).toBe(true)
})
it('installer discovers explicit, environment, shell and common paths in order', () => {
  const source = readFileSync('install.sh', 'utf8')
  const discovery = source.slice(
    source.indexOf('discover_claude() {'),
    source.indexOf('\n# End Claude discovery')
  )
  const home = temporary('discovery-')
  const bins = ['explicit', 'environment', 'shell', '.local/bin']
  const paths = bins.map((bin) => {
    const dir = join(home, bin)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'claude')
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o700)
    return path
  })
  for (const [explicit, environment, shell, expected] of [
    [paths[0]!, paths[1]!, true, paths[0]!],
    ['', paths[1]!, true, paths[1]!],
    ['', '', true, paths[2]!],
    ['', '', false, paths[3]!],
  ] as const) {
    const result = spawnSync(
      '/bin/sh',
      ['-c', `${discovery}\ndiscover_claude\nprintf '%s' "$claude"`],
      {
        encoding: 'utf8',
        timeout: processStepDeadlineMs,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          HOME: home,
          claude: explicit,
          ABELE_CLAUDE_PATH: environment,
          PATH: shell ? `${join(home, 'shell')}:/usr/bin:/bin` : '/usr/bin:/bin',
        },
      }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(expected)
  }
})
it('fails closed with precise actionable reasons', () => {
  for (const [version, reason] of [
    ['2.1.284', 'below minimum'],
    ['3.0.0', 'outside supported'],
    ['garbage', 'unparsable'],
  ] as const) {
    const provider = fake(version)
    expect(provider.available).toBe(false)
    expect(provider.diagnostic).toContain(reason)
    expect(provider.diagnostic).toContain('Run ')
  }
  expect(fake('2.1.292', '--resume').diagnostic).toContain(
    'missing flag --include-partial-messages'
  )
  for (const flag of flags.split(' ')) {
    expect(fake('2.1.292', flags.replace(flag, flag + '-other')).diagnostic).toContain(
      `missing flag ${flag}`
    )
  }
  expect(fake('2.1.291', '', 1).capabilities().capabilities.permissions.status).toBe('unverified')
  expect(fake('2.1.292', 'unknown permission-prompt-tool', 1).diagnostic).toContain('--help failed')
  expect(
    new ClaudeProviderAdapter({ executable: join(tmpdir(), 'nonexistent-claude') }).diagnostic
  ).toContain('not found at path')
})
it('status and doctor expose an actionable unavailable reason while stopped', () => {
  const state = temporary('diagnostics-')
  const missing = join(state, 'missing-claude')
  for (const command of ['status', 'doctor']) {
    const result = spawnSync(
      process.execPath,
      [
        'packages/node-daemon/dist/cli.js',
        '--json',
        command,
        '--state-dir',
        state,
        '--claude-path',
        missing,
      ],
      { encoding: 'utf8', timeout: processStepDeadlineMs, killSignal: 'SIGKILL' }
    )
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.claude.available).toBe(false)
    expect(report.claude.diagnostic).toContain(`not found at path ${missing}`)
    expect(report.claude.diagnostic).toContain('sh install.sh --claude-path')
    expect(report.claude.diagnostic).not.toContain('\n')
  }
})
