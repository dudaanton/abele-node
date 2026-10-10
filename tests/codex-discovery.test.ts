import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { SessionSchema, DelegationGrantRequestSchema } from '@abele/node-protocol'
import {
  discoverCodex,
  checkManagedRequirements,
} from '../packages/provider-codex/src/discovery.js'

it('does not route unknown providers to Claude', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-registry-'))
  const adapter: any = { available: true, capabilities: () => ({ provider: 'claude' }) }
  const core = new NodeCore(dir, { claude: adapter })
  try {
    expect(core.execution.isAvailable('unknown')).toBe(false)
    expect(core.execution.capabilities('unknown')).toMatchObject({ available: false })
  } finally {
    await core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('accepts bounded Codex IDs without weakening Claude UUID validation or extending old grants', () => {
  const base = {
    session_id: '00000000-0000-4000-8000-000000000001',
    title: '',
    created_at: new Date().toISOString(),
  }
  expect(
    SessionSchema.parse({ ...base, provider: 'codex', native_session_id: 'thread_opaque:1' })
      .provider
  ).toBe('codex')
  expect(
    SessionSchema.safeParse({ ...base, provider: 'claude', native_session_id: 'thread_opaque:1' })
      .success
  ).toBe(false)
  expect(
    SessionSchema.safeParse({ ...base, provider: 'codex', native_session_id: '../rollout' }).success
  ).toBe(false)
  const grant = DelegationGrantRequestSchema.parse({ parent_id: base.session_id, project_ids: [] })
  expect(grant.providers).not.toContain('codex')
})
it('discovers only explicit absolute fixtures and detects replacement', () => {
  const dir = mkdtempSync(resolve('.scratch/codex-discovery-'))
  const executable = join(dir, 'codex.mjs')
  copyFileSync(resolve('tests/fixtures/codex.mjs'), executable)
  chmodSync(executable, 0o700)
  try {
    expect(() => discoverCodex({ executable: './codex' })).toThrow('absolute')
    const discovered = discoverCodex({ executable, fixture: true })
    expect(discovered.version).toBe('0.160.1')
    discovered.recheck()
    writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("codex-cli 0.160.1")\n')
    expect(() => discovered.recheck()).toThrow('identity_changed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
afterEach(() => vi.unstubAllEnvs())
it('automatically discovers a pinned Codex in common user locations without shell PATH', () => {
  const dir = mkdtempSync(resolve('.scratch/codex-auto-discovery-'))
  vi.stubEnv('HOME', dir)
  vi.stubEnv('ABELE_CODEX_PATH', '')
  mkdirSync(join(dir, '.local/bin'), { recursive: true })
  const executable = join(dir, '.local/bin/codex')
  copyFileSync(resolve('tests/fixtures/codex.mjs'), executable)
  chmodSync(executable, 0o700)
  try {
    expect(discoverCodex({ trustedPath: '', fixture: true }).executable).toBe(executable)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('searches absolute daemon PATH entries, skipping incompatible candidates without executing wrappers', () => {
  const dir = mkdtempSync(resolve('.scratch/codex-auto-path-'))
  vi.stubEnv('HOME', dir)
  vi.stubEnv('ABELE_CODEX_PATH', '')
  const bad = join(dir, 'bad'),
    good = join(dir, 'good')
  mkdirSync(bad)
  mkdirSync(good)
  writeFileSync(join(bad, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  copyFileSync(resolve('tests/fixtures/codex.mjs'), join(good, 'codex'))
  chmodSync(join(good, 'codex'), 0o700)
  try {
    expect(discoverCodex({ trustedPath: `.:${bad}:${good}`, fixture: true }).executable).toBe(
      join(good, 'codex')
    )
    expect(() => discoverCodex({ executable: join(bad, 'codex'), trustedPath: good })).toThrow(
      'wrapper_unsupported'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('requires an administrator-owned regular requirements file and directory', () => {
  const safe = { uid: 0, mode: 0o100644, isSymbolicLink: () => false }
  const parent = { ...safe, mode: 0o40755 }
  expect(() => checkManagedRequirements(safe, parent)).not.toThrow()
  for (const bad of [
    { ...safe, uid: 501 },
    { ...safe, mode: 0o100666 },
    { ...safe, isSymbolicLink: () => true },
  ])
    expect(() => checkManagedRequirements(bad, parent)).toThrow('unsafe_managed_requirements')
})
