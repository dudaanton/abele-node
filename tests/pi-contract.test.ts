import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { SessionSchema, PromptSchema, validateParams } from '@abele/node-protocol'
import { PiProviderAdapter } from '@abele/provider-pi'

it('accepts pi selection and exact native file mapping without a protocol fork', () => {
  expect(
    validateParams('session.create', { title: 'pi', provider: 'pi', workspace_id: 'w' })
  ).toMatchObject({ provider: 'pi' })
  expect(
    SessionSchema.parse({
      session_id: 's',
      title: 'pi',
      provider: 'pi',
      native_session_id: '12345678-1234-4234-8234-123456789abc',
      native_session_file: '/state/pi/s/session.jsonl',
      created_at: new Date().toISOString(),
    })
  ).toHaveProperty('native_session_file')
})
it('validates durable extension questions and bounded answers', () => {
  const prompt = {
    kind: 'select',
    prompt_id: 'p',
    session_id: 's',
    run_id: 'r',
    revision: 1,
    action_digest: 'a'.repeat(64),
    expires_at: 100,
    state: 'pending',
    choice: null,
    installation_id: null,
    delivered: false,
    title: 'Choose',
    options: ['A', 'B'],
  }
  expect(PromptSchema.parse(prompt)).toMatchObject({ kind: 'select', options: ['A', 'B'] })
  expect(
    validateParams('prompt.answer', {
      session_id: 's',
      prompt_id: 'p',
      run_id: 'r',
      revision: 1,
      action_digest: 'a'.repeat(64),
      choice: 'allow',
      value: 'B',
    })
  ).toHaveProperty('value', 'B')
  expect(() =>
    validateParams('prompt.answer', {
      session_id: 's',
      prompt_id: 'p',
      run_id: 'r',
      revision: 1,
      action_digest: 'a'.repeat(64),
      choice: 'allow',
      value: 'x'.repeat(32769),
    })
  ).toThrow()
})
it('advertises only accepted SDK features while retaining unverified extension/context gates', () => {
  const report = new PiProviderAdapter({ stateDir: process.cwd() }).capabilities()
  expect(report.provider_version).toBe('0.87.0')
  expect(report.capabilities.permissions).toMatchObject({
    status: 'supported',
    evidence: 'sdk-0.87.0-node-client-allow-deny-expiry-v1',
  })
  expect(report.capabilities.resume).toMatchObject({
    status: 'supported',
    evidence: 'sdk-0.87.0-native-file-interrupt-resume-v1',
  })
  expect(report.capabilities.extension_prompts.status).toBe('unverified')
  expect(report.capabilities.compaction.status).toBe('unverified')
  expect(report.capabilities.exhaustive_children.status).toBe('unverified')
  expect(report.capabilities.steering.status).toBe('unsupported')
})
it('uses the patched transitive package on disk, not only a clean-looking lockfile', () => {
  const sdk = createRequire(
    new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url)
  )
  const minimatch = createRequire(sdk.resolve('minimatch'))
  const brace = minimatch.resolve('brace-expansion')
  expect(
    JSON.parse(readFileSync(new URL('../../package.json', 'file://' + brace), 'utf8')).version
  ).toBe('5.0.12')
})
