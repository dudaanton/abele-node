import { afterEach, expect, vi } from 'vitest'
import { processIt as it } from './process-test.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { processStepDeadlineMs } from '../scripts/process-test-budget.mjs'
import { control, startDaemon } from '../packages/node-daemon/src/index.js'
import { humanError } from '../packages/node-daemon/src/output.js'

const dirs: string[] = [],
  stops: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const stop of stops.splice(0)) await stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const endpoint = 'wss://node.example.ts.net:8443/channel'
async function daemon() {
  const dir = mkdtempSync(resolve('.scratch/serve-daemon-'))
  dirs.push(dir)
  const serveState = join(dir, 'fake-serve.json')
  vi.stubEnv('FAKE_TAILSCALE_SERVE_STATE', serveState)
  // A background service has no GUI session; the app bundle's CLI must still answer.
  vi.stubEnv('TAILSCALE_BE_CLI', undefined)
  const started = await startDaemon(
    dir,
    0,
    undefined,
    {},
    {
      endpoint,
      backend_port: 0,
      origins: ['app://obsidian.md'],
      allow_missing_origin: false,
      allow_null_origin: false,
    },
    resolve('tests/fixtures/tailscale-app.mjs')
  )
  stops.push(started.stop)
  return { dir, serveState, started }
}

it('serve enable through the daemon drives the app bundle CLI and confirms ownership', async () => {
  const { dir, serveState, started } = await daemon()
  await expect(
    control(dir, { action: 'tailscale.enable', policy_verified: true })
  ).resolves.toEqual({ action: 'tailscale.enable', completed: true })
  expect(existsSync(serveState)).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, 'serve-ownership.json'), 'utf8'))).toEqual({
    endpoint,
    backend_port: started.paired_port,
    state: 'confirmed',
  })
  // Idempotent on a confirmed exact mapping.
  await expect(
    control(dir, { action: 'tailscale.enable', policy_verified: true })
  ).resolves.toMatchObject({ completed: true })
})

it('a real serve failure reaches the operator as its own reason in plain words', async () => {
  vi.stubEnv('FAKE_TAILSCALE_REFUSE', 'Serve is not enabled on your tailnet.')
  const { dir } = await daemon()
  const error = await control(dir, { action: 'tailscale.enable', policy_verified: true }).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).not.toBe('invalid_control_command')
  expect((error as Error).message).toMatch(/^tailscale_command_failed: /)
  const text = humanError(error)
  expect(text).toContain('Serve is not enabled on your tailnet')
  expect(text).toContain('Tailscale refused')
  expect(text).toMatch(/\(tailscale_command_failed\)$/)
})

it('malformed control requests still answer invalid_control_command', async () => {
  const { dir } = await daemon()
  await expect(
    control(dir, { action: 'tailscale.enable', policy_verified: false } as never)
  ).rejects.toThrow('invalid_control_command')
})

it('doctor through the CLI shows the tailnet policy as ready once serve was enabled', async () => {
  const { dir, serveState } = await daemon()
  await control(dir, { action: 'tailscale.enable', policy_verified: true })
  const doctor = await promisify(execFile)(
    process.execPath,
    [
      resolve('packages/node-daemon/dist/cli.js'),
      'doctor',
      '--state-dir',
      dir,
      '--tailscale-path',
      resolve('tests/fixtures/tailscale-app.mjs'),
    ],
    {
      timeout: processStepDeadlineMs,
      env: { ...process.env, FAKE_TAILSCALE_SERVE_STATE: serveState },
    }
  )
  expect(doctor.stdout).toContain('OK Serve mapping: ready')
  expect(doctor.stdout).toContain('OK Tailnet policy: ready')
  expect(doctor.stdout).not.toMatch(/PROBLEM (Serve mapping|Tailnet policy)/)
})
