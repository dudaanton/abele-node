import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, statSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ensureCodexHome } from '../packages/provider-codex/src/home.js'
it('uses only a private canonical node-owned home and refuses credential/config aliases', () => {
  const state = mkdtempSync(resolve('.scratch/codex-home-'))
  try {
    const home = ensureCodexHome(state)
    expect(home).toBe(join(state, 'codex'))
    expect(statSync(home).mode & 0o777).toBe(0o700)
    symlinkSync(join(state, 'external-auth'), join(home, 'auth.json'))
    expect(() => ensureCodexHome(state)).toThrow('unsafe_home')
    rmSync(join(home, 'auth.json'))
    writeFileSync(join(home, 'auth.json'), '{}', { mode: 0o644 })
    expect(() => ensureCodexHome(state)).toThrow('unsafe_home')
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
