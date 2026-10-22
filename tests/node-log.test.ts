import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  rmSync,
  linkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { NodeLogTailSchema, MUTATIONS } from '@abele/node-protocol'

const fixtures: { core: NodeCore; root: string }[] = []
function fixture() {
  mkdirSync('.scratch', { recursive: true })
  const root = mkdtempSync(resolve('.scratch/node-log-'))
  const core = new NodeCore(join(root, 'state'))
  fixtures.push({ core, root })
  const owner = core.authority.authenticate(core.createToken('log owner').token)
  const logs = join(core.stateDir, 'logs')
  mkdirSync(logs)
  const tail = async (params: unknown = {}): Promise<any> =>
    core.request(owner, 'node.log.v1.tail', params)
  return { core, root, logs, owner, tail }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const { core, root } of fixtures.splice(0)) {
    await core.manager.stop()
    await core.resources.stop()
    core.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('advertises a read-only bounded tail with a 200 line default', async () => {
  const f = fixture()
  writeFileSync(
    join(f.logs, 'stdout.log'),
    Array.from({ length: 240 }, (_, n) => `line ${n}`).join('\n') + '\n'
  )
  const result = await f.tail()
  NodeLogTailSchema.parse(result)
  expect(MUTATIONS.has('node.log.v1.tail')).toBe(false)
  expect(f.core.capabilities().capabilities).toHaveProperty('node_log_v1.status', 'supported')
  expect(result.lines).toHaveLength(200)
  expect(result.lines[0]).toMatchObject({
    text: 'line 40',
    time: null,
    level: 'unknown',
    source: 'stdout',
  })
  expect((await f.tail({ limit: 2 })).lines.map((line: any) => line.text)).toEqual([
    'line 238',
    'line 239',
  ])
  for (const params of [
    { limit: 1001 },
    { limit: 0 },
    { path: '../node.sqlite' },
    { since: 'invalid' },
    { level: 'debug' },
  ])
    await expect(f.tail(params)).rejects.toThrow('invalid_params')
})
it('parses JSON and plain timestamps/levels, merges streams and filters before tailing', async () => {
  const f = fixture()
  writeFileSync(
    join(f.logs, 'stdout.log'),
    [
      JSON.stringify({ time: Date.parse('2026-10-22T10:00:00Z'), level: 30, msg: 'ready' }),
      '2026-10-22T10:00:03Z [WARN] retrying',
      'unstructured continuation',
    ].join('\n') + '\n'
  )
  writeFileSync(
    join(f.logs, 'stderr.log'),
    JSON.stringify({ timestamp: '2026-10-22T10:00:02Z', level: 'error', message: 'failed' }) + '\n'
  )
  const result = await f.tail({
    since: '2026-10-22T10:00:01Z',
    level: 'warnings_and_errors',
    limit: 2,
  })
  expect(result.lines.map((line: any) => [line.time, line.level, line.source])).toEqual([
    ['2026-10-22T10:00:02.000Z', 'error', 'stderr'],
    ['2026-10-22T10:00:03.000Z', 'warn', 'stdout'],
  ])
})
it('returns explicit empty/missing reasons and reopens active files after rotation', async () => {
  const f = fixture()
  expect(await f.tail()).toMatchObject({ lines: [], reason: 'logs_missing' })
  writeFileSync(join(f.logs, 'stdout.log'), '')
  expect(await f.tail()).toMatchObject({ lines: [], reason: 'empty' })
  writeFileSync(join(f.logs, 'stdout.log'), 'old\n')
  expect((await f.tail()).lines[0].text).toBe('old')
  renameSync(join(f.logs, 'stdout.log'), join(f.logs, 'stdout.log.1'))
  expect(await f.tail()).toMatchObject({ lines: [], reason: 'logs_missing' })
  writeFileSync(join(f.logs, 'stdout.log'), 'new\n')
  expect((await f.tail()).lines.map((line: any) => line.text)).toEqual(['new'])
})
it.each(['directory', 'file', 'hardlink'])(
  'does not read outside its log directory through a %s',
  async (kind) => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'stdout.log'), 'private outside data\n')
    if (kind === 'directory') {
      rmSync(f.logs, { recursive: true })
      symlinkSync(outside, f.logs)
    } else if (kind === 'file') symlinkSync(join(outside, 'stdout.log'), join(f.logs, 'stdout.log'))
    else linkSync(join(outside, 'stdout.log'), join(f.logs, 'stdout.log'))
    const result = await f.tail()
    expect(result.lines).toEqual([])
    expect(JSON.stringify(result)).not.toContain('private outside data')
    expect(result.reason).toBe('logs_unavailable')
  }
)
it('refuses unauthenticated, non-owner, unconfirmed and revoked principals', async () => {
  const f = fixture()
  for (const actor of [
    { installation_id: 'agent' },
    { installation_id: f.owner.installation_id },
    { ...f.owner, profile: 'delegation-v1' },
  ]) {
    await expect(
      Promise.resolve().then(() => f.core.request(actor as any, 'node.log.v1.tail', {}))
    ).rejects.toThrow()
  }
  const paired = f.core.authority.authenticate(f.core.createToken('paired log owner').token)
  f.core.db
    .prepare('INSERT INTO paired_devices VALUES(?,?,?,?)')
    .run(paired.installation_id, 'device-key', 'fingerprint', 'pending')
  await expect(
    Promise.resolve().then(() =>
      f.core.request(
        { ...paired, profile: 'paired-wss-v1', device_key: 'device-key' },
        'node.log.v1.tail',
        {}
      )
    )
  ).rejects.toThrow('unauthorized')
  f.core.db
    .prepare("UPDATE paired_devices SET state='confirmed' WHERE installation_id=?")
    .run(paired.installation_id)
  expect(
    await f.core.request(
      { ...paired, profile: 'paired-wss-v1', device_key: 'device-key' },
      'node.log.v1.tail',
      {}
    )
  ).toHaveProperty('lines')
  f.core.db
    .prepare('UPDATE installations SET revoked=1 WHERE installation_id=?')
    .run(f.owner.installation_id)
  await expect(f.tail()).rejects.toThrow('unauthorized')
})
it('redacts credentials, pairing secrets, headers, PEM keys and echoed/encoded secret values before returning logs', async () => {
  const f = fixture()
  const secret = 'fixture secret / value'
  writeFileSync(
    join(f.logs, 'stdout.log'),
    [
      JSON.stringify({ level: 'info', nested: { api_key: secret }, msg: 'configured' }),
      `echo ${secret} encoded ${encodeURIComponent(secret)}`,
      'Authorization: Bearer header-credential',
      'Cookie: session=cookie-credential; auth=another-cookie',
      'pairing_secret=pairing-credential token=token-credential password=password-credential',
      '--api-key cli-credential',
      'https://user:url-password@example.invalid/path?token=query-credential',
      '-----BEGIN PRIVATE KEY-----',
      'private-key-body',
      '-----END PRIVATE KEY-----',
      'sk-test_abcdefghijklmnopqrstuvwxyz1234567890',
      'a'.repeat(64),
    ].join('\n') + '\n'
  )
  const result = JSON.stringify(await f.tail())
  for (const value of [
    secret,
    encodeURIComponent(secret),
    'header-credential',
    'cookie-credential',
    'another-cookie',
    'pairing-credential',
    'token-credential',
    'password-credential',
    'cli-credential',
    'url-password',
    'query-credential',
    'private-key-body',
    'sk-test_abcdefghijklmnopqrstuvwxyz1234567890',
    'a'.repeat(64),
  ])
    expect(result).not.toContain(value)
  expect(result).toContain('configured')
})
it('bounds huge files and lines within one channel response without exposing a clipped secret', async () => {
  const f = fixture()
  writeFileSync(join(f.logs, 'stdout.log'), 'token=' + 'X'.repeat(400000) + '\nlast safe line\n')
  const result = await f.tail()
  expect(result.truncated).toBe(true)
  expect(JSON.stringify(result).length).toBeLessThan(200000)
  expect(result.lines.map((line: any) => line.text)).toEqual(['last safe line'])
})
it('masks known environment values, short generic keys and a private key crossing the scan boundary', async () => {
  const f = fixture()
  vi.stubEnv('FIXTURE_API_KEY', 'environment-only-credential')
  writeFileSync(
    join(f.logs, 'stdout.log'),
    [
      '-----BEGIN PRIVATE KEY-----',
      'padding\n'.repeat(40000),
      'boundary-private-material',
      '-----END PRIVATE KEY-----',
      'echo environment-only-credential',
      '{"key":"generic-key-secret"}',
    ].join('\n') + '\n'
  )
  const result = JSON.stringify(await f.tail())
  for (const secret of [
    'boundary-private-material',
    'environment-only-credential',
    'generic-key-secret',
  ])
    expect(result).not.toContain(secret)
})
it('redacts short labelled credentials while retaining structured timestamp and severity', async () => {
  const f = fixture()
  writeFileSync(
    join(f.logs, 'stdout.log'),
    '{"time":"2026-10-22T10:00:00Z","level":"warn","key":"ab","message":"ready"}\npassword=z\nAuthorization: q\n--token r\n'
  )
  const result = await f.tail()
  expect(result.lines.find((line: any) => line.text.includes('ready'))).toMatchObject({
    time: '2026-10-22T10:00:00.000Z',
    level: 'warn',
  })
  expect(result.lines.map((line: any) => line.text).join('\n')).not.toMatch(
    /password=z|Authorization: q|--token r|"key":"ab"/
  )
})
it('withholds multiline credential objects whose individual fields are not labelled secrets', async () => {
  const f = fixture()
  writeFileSync(
    join(f.logs, 'stdout.log'),
    'configuration:\n  credentials: {\n    value: "hidden-multiline-value"\n  }\n'
  )
  expect(JSON.stringify(await f.tail())).not.toContain('hidden-multiline-value')
})
