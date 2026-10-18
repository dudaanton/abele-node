import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  readlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const [os, arch, supported, nodeArch] of [
  ['Darwin', 'x86_64', false],
  ['Darwin', 'arm64', true],
  ['Darwin', 'arm64', false, 'x64'],
  ['Linux', 'x86_64', true],
  ['Linux', 'aarch64', true],
]) {
  test(`installer platform gate: ${os}-${arch}${nodeArch ? ` Node ${nodeArch}` : ''}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'abele-platform-'))
    try {
      const bin = join(home, 'bin')
      await mkdir(bin)
      await writeFile(join(home, 'installation-state'), 'existing runtime and state')
      const deployment = join(home, '.local/share/abele-node')
      await mkdir(join(deployment, '0.4.30'), { recursive: true })
      await symlink('0.4.30', join(deployment, 'current'))
      const config = '{"version":"0.4.30","service_enabled":true}'
      await writeFile(join(deployment, 'config.json'), config)
      for (const [name, body] of Object.entries({
        id: 'echo 501',
        uname: `if [ "$1" = -s ]; then echo ${os}; else echo ${arch}; fi`,
        node: nodeArch
          ? `if [ "$1" = -p ]; then echo ${nodeArch}; fi; exit 0`
          : 'echo node >> "$HOME/calls"; exit 1',
        curl: 'echo curl >> "$HOME/calls"; exit 1',
        launchctl: 'echo launchctl >> "$HOME/calls"; exit 1',
        systemctl: 'echo systemctl >> "$HOME/calls"; exit 1',
      }))
        await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      const result = spawnSync('/bin/sh', [resolve('install.sh'), '--version', '0.4.31'], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
      if (supported) {
        assert.match(result.stderr, /Install Node.js/)
        assert.equal(await readFile(join(home, 'calls'), 'utf8'), 'node\n')
      } else {
        assert.match(result.stderr, /Unsupported platform: macOS x64/)
        assert.match(result.stderr, /native arm64 shell and Node.js/)
        assert.deepEqual((await readdir(home)).sort(), ['.local', 'bin', 'installation-state'])
      }
      assert.equal(await readlink(join(deployment, 'current')), '0.4.30')
      assert.equal(await readFile(join(deployment, 'config.json'), 'utf8'), config)
      assert.equal(
        await readFile(join(home, 'installation-state'), 'utf8'),
        'existing runtime and state'
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}

test('packager rejects Darwin x64 before creating output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'abele-package-platform-'))
  try {
    const output = join(home, 'release')
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      Object.defineProperty(process, 'platform', {value: 'darwin'});
      Object.defineProperty(process, 'arch', {value: 'x64'});
      process.argv[2] = ${JSON.stringify(output)};
      await import(${JSON.stringify(resolve('scripts/package-release.mjs'))});
    `,
      ],
      { encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unsupported_release_platform/)
    assert.deepEqual(await readdir(home), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('release matrix contains exactly the three supported platforms', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  assert.deepEqual([...workflow.matchAll(/platform: ([\w-]+)/g)].map((m) => m[1]).sort(), [
    'darwin-arm64',
    'linux-arm64',
    'linux-x64',
  ])
})
