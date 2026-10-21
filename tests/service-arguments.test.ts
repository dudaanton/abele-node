import { expect, it } from 'vitest'
import {
  retainServiceArguments,
  summarizeServiceFlags,
  validateServiceFlags,
} from '../packages/node-daemon/src/service-arguments.js'

it('summarizes effective service flags including defaults and debugger', () => {
  expect(summarizeServiceFlags([])).toBe(
    'Permission TTL: 60000 ms\nPi deadline: 1800000 ms\nPi max tokens: 32768\nDebugger: off\nAllow bypass: off'
  )
  expect(
    summarizeServiceFlags([
      '--permission-ttl-ms',
      '120000',
      '--pi-deadline-ms',
      '900000',
      '--pi-max-tokens',
      '8192',
      '--debugger',
    ])
  ).toBe(
    'Permission TTL: 120000 ms\nPi deadline: 900000 ms\nPi max tokens: 8192\nDebugger: on\nAllow bypass: off'
  )
})

it('toggles operator bypass without consuming neighbouring arguments and retains it across runtimes', () => {
  expect(() => validateServiceFlags({ '--allow-bypass': 'on' })).not.toThrow()
  expect(() => validateServiceFlags({ '--allow-bypass': 'off' })).not.toThrow()
  expect(() => validateServiceFlags({ '--allow-bypass': 'yes' })).toThrow()
  const old = 'ExecStart="/node" "/old/cli.js" "start" "--claude-allow-bypass" "--debugger"'
  expect(retainServiceArguments(generated, old, 'linux')).toContain('--claude-allow-bypass')
  expect(retainServiceArguments(generated, old, 'linux', { '--allow-bypass': 'off' })).toEqual([
    ...generated.slice(0, 2),
    'start',
    '--debugger',
  ])
  expect(
    retainServiceArguments(generated, old, 'linux', { '--allow-bypass': 'on' }).filter(
      (s) => s === '--claude-allow-bypass'
    )
  ).toHaveLength(1)
  expect(summarizeServiceFlags(['--claude-allow-bypass'])).toContain('Allow bypass: on')
})

const previous = [
  '/node',
  '/old/cli.js',
  'start',
  '--permission-ttl-ms',
  '3600000',
  '--pi-deadline-ms',
  '1800000',
  '--pi-max-tokens',
  '32768',
  '--future-option',
  'space & "quote"',
  '--no-pi-live',
]
const generated = ['/new-node', '/new/cli.js', 'start', '--pi-max-tokens', '4096']
it.each(['darwin', 'linux'] as const)(
  'retains every service argument on %s, replacing only the runtime',
  (os) => {
    const text =
      os === 'darwin'
        ? '<key>ProgramArguments</key><array>' +
          previous
            .map(
              (s) => '<string>' + s.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '</string>'
            )
            .join('') +
          '</array>'
        : 'ExecStart=' +
          previous
            .map((s) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"')
            .join(' ')
    expect(retainServiceArguments(generated, text, os)).toEqual([
      ...generated.slice(0, 2),
      ...previous.slice(2),
    ])
  }
)
it('refuses an unrecognized service command instead of silently dropping flags', () => {
  expect(() =>
    retainServiceArguments(generated, 'ExecStart=/node /old/cli.js start --unknown', 'linux')
  ).toThrow('unsupported_service_arguments')
})
it('applies explicit service changes without resetting unrelated owner flags', () => {
  const old =
    'ExecStart="/node" "/old/cli.js" "start" "--debugger" "--paired-config" "/old" "--pi-max-tokens" "32768" "--no-codex"'
  expect(
    retainServiceArguments(generated, old, 'linux', {
      '--debugger': false,
      '--paired-config': '/new',
      '--no-codex': false,
    })
  ).toEqual([
    ...generated.slice(0, 2),
    'start',
    '--pi-max-tokens',
    '32768',
    '--paired-config',
    '/new',
  ])
})
