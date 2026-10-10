import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { generateAndVerifySchemas, inspectCodex } from '../packages/provider-codex/src/doctor.js'
import { pinnedSchemas, verifySchemaDirectory } from '../packages/provider-codex/src/schema.js'

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
