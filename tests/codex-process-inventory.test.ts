import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import {
  CodexProcessInventory,
  markerInEnvironment,
  CODEX_PROCESS_MARKER,
} from '../packages/provider-codex/src/processes.js'

it('matches exact markers without returning environment contents', () => {
  const marker = 'a'.repeat(64)
  expect(
    markerInEnvironment(
      Buffer.from(`OTHER=secret\0${CODEX_PROCESS_MARKER}=${marker}\0`),
      marker,
      'linux'
    )
  ).toBe(true)
  expect(markerInEnvironment(`${CODEX_PROCESS_MARKER}=${marker}x`, marker, 'darwin')).toBe(false)
  expect(
    markerInEnvironment(`node ${CODEX_PROCESS_MARKER}=${marker} OTHER=secret`, marker, 'darwin')
  ).toBe(true)
  expect(
    markerInEnvironment(`node -c ${CODEX_PROCESS_MARKER}=\"${marker}\"`, marker, 'darwin')
  ).toBe(false)
})
it('sweeps only this run marker and cleans a reparented detached fixture without touching another run', async () => {
  const directory = mkdtempSync(resolve('.scratch/codex-inventory-')),
    pidfile = join(directory, 'child.pid'),
    otherfile = join(directory, 'other.pid')
  const marker = randomBytes(32).toString('hex'),
    otherMarker = randomBytes(32).toString('hex')
  const launch = (file: string, token: string) =>
    spawn(
      process.execPath,
      [
        '-e',
        `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,${CODEX_PROCESS_MARKER}:process.env.${CODEX_PROCESS_MARKER}}});writeFileSync(${JSON.stringify(file)},String(child.pid));child.unref()`,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { PATH: process.env.PATH, [CODEX_PROCESS_MARKER]: token },
      }
    )
  const parent = launch(pidfile, marker),
    otherParent = launch(otherfile, otherMarker),
    evidence: any[] = []
  let owned: any, unrelated: any
  try {
    await Promise.all([
      new Promise((r) => parent.once('close', r)),
      new Promise((r) => otherParent.once('close', r)),
    ])
    owned = systemProcessProbe.identity(Number(readFileSync(pidfile, 'utf8')))
    unrelated = systemProcessProbe.identity(Number(readFileSync(otherfile, 'utf8')))
    expect(owned).toBeDefined()
    expect(unrelated).toBeDefined()
    const inventory = new CodexProcessInventory(marker, (p) => evidence.push(...p))
    await inventory.cleanup()
    expect(systemProcessProbe.identity(owned.pid)).toBeUndefined()
    expect(systemProcessProbe.identity(unrelated.pid)?.fingerprint).toBe(unrelated.fingerprint)
    expect(evidence.some((p) => p.pid === owned.pid)).toBe(true)
  } finally {
    if (owned) await ProcessSupervisor.cleanup([owned], 100)
    if (unrelated) await ProcessSupervisor.cleanup([unrelated], 100)
    rmSync(directory, { recursive: true, force: true })
  }
})
it('refreshes a sampled descendant group only for the same birth identity, and rejects PID reuse', () => {
  let actual: any = { pid: 99, group: 99, fingerprint: 'original' }
  const saved: any[] = []
  const inventory = new CodexProcessInventory(
    'b'.repeat(64),
    (p) => saved.push(p),
    { identity: () => actual, groupMembers: () => [] },
    () => []
  )
  inventory.add([{ ...actual, group: 80 }])
  inventory.refresh()
  expect(saved.at(-1)[0].group).toBe(99)
  actual = { ...actual, fingerprint: 'reused' }
  expect(() => inventory.refresh()).toThrow('process_identity_changed')
})
