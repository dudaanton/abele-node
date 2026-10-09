import { expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

it('ships public source metadata, installation guides and a pinned non-root image', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  // The published compose example and the Docker guide name the image of this exact version.
  expect(readFileSync('docker-compose.example.yml', 'utf8')).toContain(
    `ghcr.io/dudaanton/abele-node:${pkg.version}`
  )
  expect(readFileSync('docs/docker.md', 'utf8')).toContain(
    `ghcr.io/dudaanton/abele-node:${pkg.version}`
  )
  expect(pkg.license).toBe('GPL-3.0-only')
  expect(pkg.repository.url).toBe('https://github.com/dudaanton/abele-node.git')
  for (const file of [
    'LICENSE',
    'docs/install.md',
    'docs/docker.md',
    'docs/security.md',
    'docs/remote-access.md',
  ])
    expect(existsSync(file), file).toBe(true)
  const docker = readFileSync('Dockerfile', 'utf8')
  expect(docker).toMatch(/FROM node:22[^\s]*@sha256:[a-f0-9]{64}/)
  expect(docker).toMatch(/USER node/)
  expect(docker).toMatch(/HEALTHCHECK/)
  expect(docker).toContain('COPY scripts/prepare-pi.mjs scripts/prepare-pi.mjs')
  expect(docker).toMatch(/npm prune --omit=dev --ignore-scripts\s*&& node scripts\/prepare-pi\.mjs/)
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
    'docs/remote-access.md',
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
  expect(readme).toContain('Durable sessions')
  expect(readme).toContain('managed Git worktrees')
  expect(readme).toContain('Bounded UTF-8 file editing/creation')
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

it('documents paired availability and keeps remote configuration examples deployment-neutral', () => {
  const readme = readFileSync('README.md', 'utf8')
  expect(readme).toMatch(/Local-token control stays loopback-only/)
  expect(readme).toMatch(
    /Node-side paired WSS\s+through Tailscale Serve is available but separately enabled/
  )
  expect(readme).toMatch(/plugin pairing UI is\s+not yet released/)
  expect(readme).toContain('docs/remote-access.md')
  expect(readme).not.toMatch(/Remote control, pairing.*planned, not implemented/s)
  const security = readFileSync('docs/security.md', 'utf8')
  expect(security).toContain('## Local admission and authority')
  expect(security).toContain('## Paired remote admission')
  expect(security).toContain('refuses `local-token-v1` even from loopback')
  expect(security).toContain('[remote access](remote-access.md)')
  const remote = readFileSync('docs/remote-access.md', 'utf8')
  expect(remote).toContain('YOUR_PAIRED_WSS_ENDPOINT')
  expect(remote).not.toMatch(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i)
  expect(remote).not.toMatch(/(?:\/(?:Users|home|Applications|Volumes)\/|~\/|\/path\/to\/)/)
  expect(remote).not.toMatch(
    /\b(?:stage\s+\d+|node-side slice|owner\/manager|review[- ]round|agent harness|manager note)\b/i
  )
  expect(remote).not.toContain('../tests/security-regression-sensitivity.md')
})

it('documents pi availability neutrally and retains capability and publication gates', () => {
  const readme = readFileSync('README.md', 'utf8')
  expect(readme).toContain('docs/pi.md')
  expect(readme).toMatch(/pi SDK provider.*available/i)
  expect(readme).toMatch(/capability.gated/i)
  expect(readme).not.toContain('pi has no execution adapter yet')
  for (const file of ['README.md', 'docs/security.md', 'docs/pi.md']) {
    const text = readFileSync(file, 'utf8')
    expect(text, file).not.toMatch(
      /\b(?:agent harness|review[- ]round|stage\s+\d+|manager note)\b/i
    )
    expect(text, file).not.toMatch(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i)
    expect(text, file).not.toMatch(/(?:\/(?:Users|home|Applications|Volumes)\/|~\/|\/path\/to\/)/)
  }
  const pi = readFileSync('docs/pi.md', 'utf8')
  expect(pi).toContain('--pi-provider YOUR_PROVIDER --pi-model YOUR_MODEL')
})

it('uses subject-based names and neutral dependency and acceptance metadata', () => {
  const deps = readFileSync('deps.yaml', 'utf8')
  expect(deps.split('\n')[0]).toBe(
    '# Each version was audited before install: >=3 days old, established adoption, no OSV vulnerabilities.'
  )
  expect(deps).toMatch(/why: >-\n\s+pi SDK provider\n/)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.scripts['acceptance:pi']).toContain('scripts/acceptance-pi.mjs')
  expect(pkg.scripts['acceptance:remote']).toContain('tests/paired-security.test.ts')
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((file) => existsSync(file))
  for (const file of [
    'scripts/acceptance-pi.mjs',
    'tests/pi-acceptance.test.ts',
    'tests/security-regression-sensitivity.md',
  ])
    expect(readFileSync(file, 'utf8'), file).not.toMatch(
      /\b(?:stage\s*\d+|review[- ]round|renewed acceptance|rebase)\b/i
    )
  expect(readFileSync('tests/security-regression-sensitivity.md', 'utf8')).not.toContain('.scratch')
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
