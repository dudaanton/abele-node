import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
// @ts-expect-error JavaScript release assembly helper
import { copyWorkspaceRuntime } from '../scripts/workspace-runtime.mjs'
it('ships Codex schema pins alongside dist rather than only package metadata', () => {
  const directory = mkdtempSync(resolve('.scratch/codex-package-'))
  try {
    copyWorkspaceRuntime(resolve('packages/provider-codex'), directory)
    const pins = JSON.parse(readFileSync(join(directory, 'schemas/stable-pins.json'), 'utf8'))
    expect(Object.keys(pins.files)).toHaveLength(734)
    expect(readFileSync(join(directory, 'dist/schema.js'), 'utf8')).toContain('../schemas/')
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name).toBe(
      '@abele/provider-codex'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
