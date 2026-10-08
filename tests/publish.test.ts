import { expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

it('ships public source metadata, installation guides and a pinned non-root image', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.version).toBe('0.1.0')
  expect(pkg.license).toBe('GPL-3.0-only')
  expect(pkg.repository.url).toBe('https://github.com/dudaanton/abele-node.git')
  for (const file of ['LICENSE', 'docs/install.md', 'docs/docker.md', 'docs/security.md'])
    expect(existsSync(file), file).toBe(true)
  const docker = readFileSync('Dockerfile', 'utf8')
  expect(docker).toMatch(/FROM node:22[^\s]*@sha256:[a-f0-9]{64}/)
  expect(docker).toMatch(/USER node/)
  expect(docker).toMatch(/HEALTHCHECK/)
  expect(docker).toMatch(/git/)
  expect(docker).not.toMatch(/npm (?:install|i).*(?:claude|coding-agent)/)
  expect(readFileSync('docker-compose.example.yml', 'utf8')).toContain('127.0.0.1:7777:7778')
})

it('keeps public source free of concrete developer home paths and private probe defaults', () => {
  for (const file of [
    'README.md',
    'docs/install.md',
    'docs/docker.md',
    'docs/security.md',
    'docs/debug-probe.md',
    '.github/workflows/ci.yml',
  ])
    expect(readFileSync(file, 'utf8'), file).not.toMatch(
      /probes\/(?:phone-connectivity\.sh|phone-webview\.js|RESULTS\.md)/
    )
  for (const file of execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')) {
    const content = readFileSync(file, 'utf8')
    // /home/node is the documented container user, not a developer's home.
    expect(content, file).not.toMatch(/\/(?:Users|home)\/(?!node(?:\/|\b))[a-z][a-z0-9._-]*\//)
  }
  const probe = readFileSync('probes/pi-sdk.mjs', 'utf8')
  expect(probe).toContain('process.env.PI_PROBE_PROVIDER')
  expect(probe).toContain('PI_PROBE_PROVIDER and PI_PROBE_MODEL are required')
  const fixture = JSON.parse(readFileSync('probes/fixtures/provider-records.json', 'utf8'))
  expect(fixture.versions.pi_model).toMatch(/^fixture-/)
})

it('documents the current editing and control-endpoint contracts without publishing research evidence', () => {
  const readme = readFileSync('README.md', 'utf8')
  expect(readme).toContain('Stages 1–4B')
  expect(readme).toContain('docs/editing.md')
  expect(readme).toContain('docs/debug-probe.md')
  const install = readFileSync('docs/install.md', 'utf8')
  expect(install).toContain('control_socket')
  expect(install).toContain('temporary directory')
  const evidence = readFileSync('probes/debug-evidence.mjs', 'utf8')
  expect(evidence).toContain('.scratch/evidence/debug-probe-evidence.json')
  expect(evidence).not.toContain('docs/debug-probe-evidence.json')
  const installer = readFileSync('probes/debug-install.sh', 'utf8')
  expect(installer).toContain('DEP_CHECK="${DEP_CHECK:?')
})

it('pins workflow actions and never runs live acceptance in CI', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/image.yml']) {
    const workflow = readFileSync(file, 'utf8')
    const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]!)
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/)
    expect(workflow).not.toContain('acceptance:stage3')
    expect(workflow).not.toMatch(/node\s+probes\/(?:claude-headless|pi-sdk)\.mjs/)
    expect(workflow).not.toMatch(/debug-(?:install\.sh|real\.mjs|library-check\.mjs|evidence\.mjs)/)
    if (file.endsWith('/ci.yml')) {
      expect(workflow).toContain('node --test probes/approval-mcp.test.mjs probes/echo.test.mjs')
      expect(workflow).toContain('node --test probes/debug-*.test.mjs')
      expect(workflow).not.toContain('probes/*.test.mjs')
    }
  }
})
