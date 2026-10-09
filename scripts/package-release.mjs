// Build first. Assemble with a fresh production-only install, never the developer's node_modules.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = resolve('.')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid_release_version')
if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch))
  throw new Error('unsupported_release_platform')
const platform = `${process.platform}-${process.arch}`
const output = resolve(process.argv[2] ?? '.scratch/release')
mkdirSync(output, { recursive: true })
const staging = mkdtempSync(join(output, '.package-'))
function run(command, args, cwd = staging) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command}_failed`)
}
function strip(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (
      ['test', 'tests', '__tests__', 'spec', 'probes', '.github'].includes(entry.name) ||
      /\.(map|tsbuildinfo)$/.test(entry.name) ||
      /(^test\.|\.(test|spec|tst)[.-])/.test(entry.name)
    )
      rmSync(file, { recursive: true, force: true })
    else if (entry.isDirectory()) strip(file)
  }
}
function nativeFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) nativeFiles(file, files)
    else if (entry.isFile() && entry.name.endsWith('.node'))
      files.push(file.slice(staging.length + 1))
  }
  return files
}
try {
  for (const file of ['package.json', 'package-lock.json', '.npmrc', 'LICENSE'])
    cpSync(join(root, file), join(staging, file))
  for (const name of readdirSync('packages')) {
    const destination = join(staging, 'packages', name)
    mkdirSync(destination, { recursive: true })
    cpSync(join(root, 'packages', name, 'package.json'), join(destination, 'package.json'))
    cpSync(join(root, 'packages', name, 'dist'), join(destination, 'dist'), { recursive: true })
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts'])
  // Apply the same audited SDK dependency repair as the normal build.
  mkdirSync(join(staging, 'scripts'))
  cpSync(join(root, 'scripts/prepare-pi.mjs'), join(staging, 'scripts/prepare-pi.mjs'))
  run(process.execPath, ['scripts/prepare-pi.mjs'])
  rmSync(join(staging, 'scripts'), { recursive: true })
  // pi-tui ships native prebuilds, so releases are platform-specific, not "pure JS".
  const native = join(
    staging,
    'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/native'
  )
  for (const os of ['darwin', 'linux', 'win32']) {
    if (os !== process.platform) rmSync(join(native, os), { recursive: true, force: true })
    else {
      const prebuilds = join(native, os, 'prebuilds')
      if (!existsSync(join(prebuilds, platform))) throw new Error('missing_pi_tui_native_prebuild')
      for (const name of readdirSync(prebuilds))
        if (name !== platform) rmSync(join(prebuilds, name), { recursive: true })
    }
  }
  strip(staging)
  // A dev dependency accidentally reintroduced by npm/shrinkwrap must fail packaging.
  for (const name of [
    'typescript',
    'vitest',
    'vite',
    '@rolldown/binding',
    'lightningcss',
    'prettier',
  ]) {
    if (existsSync(join(staging, 'node_modules', name)))
      throw new Error(`dev_dependency_in_release:${name}`)
  }
  const inventory = nativeFiles(join(staging, 'node_modules'))
  if (!inventory.length || inventory.some((p) => !p.includes(platform)))
    throw new Error(`unexpected_native_inventory:${inventory}`)
  console.log('Native release inventory:', inventory)
  run(process.execPath, [
    'packages/node-daemon/dist/cli.js',
    'status',
    '--state-dir',
    join(staging, '.check-state'),
    '--claude-path',
    '/nonexistent/claude',
    '--tailscale-path',
    '/nonexistent/tailscale',
  ])
  rmSync(join(staging, '.check-state'), { recursive: true, force: true })
  const asset = `abele-node-${version}-${platform}.tar.gz`
  run('tar', ['-czf', join(output, asset), '-C', staging, '.'], root)
  const checksum = createHash('sha256')
    .update(readFileSync(join(output, asset)))
    .digest('hex')
  writeFileSync(join(output, 'SHA256SUMS'), `${checksum}  ${asset}\n`)
  console.log(`Packaged ${join(output, asset)}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
