import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { generateAndVerifySchemas, inspectCodex } from '../packages/provider-codex/src/doctor.js'
import { pinnedSchemas, verifySchemaDirectory } from '../packages/provider-codex/src/schema.js'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

it('verifies the complete recorded 0.162.1 closures and rejects a changed dependency', () => {
  const dir = mkdtempSync(resolve('.scratch/codex-new-schema-'))
  const recording = JSON.parse(
    gunzipSync(readFileSync(resolve('tests/fixtures/codex-0.162.1-schemas.json.gz'))).toString()
  )
  try {
    for (const [mode, files] of Object.entries(recording)) {
      const out = join(dir, mode)
      for (const [name, content] of Object.entries(files as Record<string, string>)) {
        mkdirSync(join(out, name, '..'), { recursive: true })
        writeFileSync(join(out, name), content)
      }
      const pins = pinnedSchemas(mode === 'experimental', '0.162.1')
      verifySchemaDirectory(out, pins)
      writeFileSync(join(out, 'v2/Turn.ts'), '// incompatible')
      expect(() => verifySchemaDirectory(out, pins)).toThrow('fingerprint_mismatch')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it.each(['0.162.1', '0.163.0'])(
  'accepts reviewed schema generation for %s without inference',
  (version) => {
    const dir = mkdtempSync(resolve('.scratch/codex-schema-generation-'))
    const executable = join(dir, 'codex.mjs')
    try {
      writeFileSync(
        executable,
        readFileSync(resolve('tests/fixtures/codex.mjs'), 'utf8')
          .replaceAll('0.160.1', '0.162.1')
          .replace('codex-cli 0.162.1', `codex-cli ${version}`),
        { mode: 0o700 }
      )
      writeFileSync(
        join(dir, 'codex-0.162.1-schemas.json.gz'),
        readFileSync(resolve('tests/fixtures/codex-0.162.1-schemas.json.gz'))
      )
      generateAndVerifySchemas(discoverCodex({ executable, fixture: true }), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
it('rejects a newer executable combining closures from different protocol versions', () => {
  const dir = mkdtempSync(resolve('.scratch/codex-mixed-schema-'))
  const executable = join(dir, 'codex.mjs')
  try {
    const old = JSON.parse(
      gunzipSync(readFileSync(resolve('tests/fixtures/codex-0.160.1-schemas.json.gz'))).toString()
    )
    const current = JSON.parse(
      gunzipSync(readFileSync(resolve('tests/fixtures/codex-0.162.1-schemas.json.gz'))).toString()
    )
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nimport {mkdirSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path'; const files = ${JSON.stringify({ stable: old.stable, experimental: current.experimental })}; const args=process.argv; const out=args[args.indexOf('--out')+1]; for(const [name,content] of Object.entries(files[args.includes('--experimental')?'experimental':'stable'])) {const file=join(out,name); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,content)}\n`
    )
    expect(() =>
      generateAndVerifySchemas(
        {
          executable,
          interpreter: process.execPath,
          version: '0.163.0',
          sha256: '',
          recheck: () => {},
        },
        dir
      )
    ).toThrow('codex_schema_fingerprint_mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('checks the full pinned schema closure and an isolated stdio inspection without turns', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-inspection-'))
  const paths = {
    workspace: join(dir, 'workspace'),
    home: join(dir, 'home'),
    state: dir,
    sibling: dir,
  }
  mkdirSync(paths.workspace)
  mkdirSync(paths.home)
  const evidence: any[] = []
  try {
    const executable = discoverCodex({
      executable: resolve('tests/fixtures/codex.mjs'),
      fixture: true,
    })
    generateAndVerifySchemas(executable, dir)
    expect(Object.keys(pinnedSchemas().files).length).toBe(734)
    expect(Object.keys(pinnedSchemas(true).files).length).toBe(875)
    expect(await inspectCodex(executable, paths, (p) => evidence.push(...p))).toEqual({
      handshake: true,
      effective_policy: true,
      managed_remote_control: true,
      authenticated: true,
      model: 'fixture-small',
      model_available: true,
    })
    expect(evidence).toHaveLength(1)
    expect(() => process.kill(evidence[0].pid, 0)).toThrow()
    writeFileSync(join(dir, 'stable/v2/ThreadStartParams.ts'), '// replaced dependency')
    expect(() => verifySchemaDirectory(join(dir, 'stable'), pinnedSchemas())).toThrow(
      'fingerprint_mismatch'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
