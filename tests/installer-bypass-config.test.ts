import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

it.each([
  ['on', '1', true],
  ['off', '1', false],
  ['on', '0', true],
] as const)(
  'installer records bypass=%s with service=%s and the actual fingerprint',
  (mode, service, expected) => {
    const directory = mkdtempSync(resolve('.scratch/bypass-publication-'))
    try {
      const state = join(directory, 'state'),
        root = join(directory, 'share/abele-node')
      mkdirSync(state)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(state, '.abele-state-identity'), 'fixture')
      const text =
        'ExecStart="/node" "/runtime/cli.js" "start"' +
        (mode === 'on' ? ' "--claude-allow-bypass"' : '') +
        '\n'
      const file = join(directory, 'service'),
        config = join(directory, 'config.json')
      writeFileSync(file, text)
      const script = readFileSync('install.sh', 'utf8').match(
        /"\$node" - "\$work\/wrapper"[^\n]*<<'NODE'\n([\s\S]*?)\nNODE/
      )![1]!
      const result = spawnSync(
        process.execPath,
        [
          '-',
          join(directory, 'wrapper'),
          config,
          process.execPath,
          root,
          state,
          '/fixture/claude',
          '0.1.0',
          service,
          file,
          'marker:' + statSync(state, { bigint: true }).ino + ':fixture',
          '',
          '',
          '',
          'true',
          '',
          'false',
        ],
        {
          input: script,
          encoding: 'utf8',
          env: {
            ...process.env,
            ABELE_SERVICE_TRANSITION: '',
            ABELE_INSTALL_ALLOW_BYPASS: String(mode === 'on'),
          },
        }
      )
      expect(result.status, result.stderr).toBe(0)
      const recorded = JSON.parse(readFileSync(config, 'utf8'))
      expect(recorded.allow_bypass_enabled).toBe(expected)
      if (service === '1') {
        expect(recorded.service_sha256).toBe(createHash('sha256').update(text).digest('hex'))
        expect(recorded.service_text).toBe(text)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
