import { it, expect } from 'vitest'
import { mkdtempSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CodexProviderAdapter } from '../packages/provider-codex/src/adapter.js'
import { CODEX_PROCESS_MARKER } from '../packages/provider-codex/src/processes.js'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import { createProcessScope, readProcessScope } from '../packages/provider-codex/src/scope.js'
it('persists a private marker before dispatch and pins recovery to the canonical state root', () => {
  const state = mkdtempSync(resolve('.scratch/codex-scope-'))
  try {
    const scope = createProcessScope(state, randomUUID())
    expect(lstatSync(scope.directory).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(scope.directory, 'scope.json')).mode & 0o777).toBe(0o600)
    expect(readProcessScope(state, scope.directory)).toBe(scope.marker)
    expect(() => readProcessScope(state, join(state, 'outside'))).toThrow()
    rmSync(join(scope.directory, 'scope.json'))
    symlinkSync(join(state, 'other'), join(scope.directory, 'scope.json'))
    expect(() => readProcessScope(state, scope.directory)).toThrow('unsafe_process_scope')
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
it('recovers a reparented marker-bearing fixture from the persisted scope even without its exited parent', async () => {
  const state = mkdtempSync(resolve('.scratch/codex-scope-')),
    scope = createProcessScope(state, randomUUID()),
    pidfile = join(state, 'pid')
  let evidence: any
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,${CODEX_PROCESS_MARKER}:process.env.${CODEX_PROCESS_MARKER}}});writeFileSync(${JSON.stringify(pidfile)},String(child.pid));child.unref()`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { PATH: process.env.PATH, [CODEX_PROCESS_MARKER]: scope.marker },
    }
  )
  try {
    await new Promise((r) => parent.once('close', r))
    evidence = systemProcessProbe.identity(Number(readFileSync(pidfile, 'utf8')))
    expect(evidence).toBeDefined()
    await new CodexProviderAdapter({ stateDir: state }).reconcile([], scope.directory)
    expect(systemProcessProbe.identity(evidence.pid)).toBeUndefined()
  } finally {
    if (evidence) await ProcessSupervisor.cleanup([evidence], 100)
    rmSync(state, { recursive: true, force: true })
  }
})
it('refuses malformed recovery markers rather than sweeping a broad or caller-supplied token', () => {
  const state = mkdtempSync(resolve('.scratch/codex-scope-'))
  try {
    const scope = createProcessScope(state, randomUUID())
    writeFileSync(
      join(scope.directory, 'scope.json'),
      JSON.stringify({ version: 1, marker: 'anything' })
    )
    expect(() => readProcessScope(state, scope.directory)).toThrow('invalid_process_marker')
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
