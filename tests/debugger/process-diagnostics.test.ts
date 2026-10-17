import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'

describe('adapter subprocess diagnostics', () => {
  it('retains bounded stderr separately from startup stdout and reports exit after streams close', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
    })
    const process = new (OwnedDebugProcess as any)(child, { pid: 999999 }, async () => 'fixture')
    const closed: unknown[] = []
    process.on('close', (diagnostics: unknown) => closed.push(diagnostics))
    child.stdout.write('listening at 127.0.0.1:1234\n')
    child.stderr.write('x'.repeat(20000) + 'fatal adapter failure')
    child.exitCode = 17
    child.emit('exit', 17, null)
    child.stderr.write('\nfinal stderr')
    child.emit('close', 17, null)
    expect(closed).toHaveLength(1)
    expect(process.diagnostics).toMatchObject({ pid: 999999, exit_code: 17, signal: null })
    expect(process.diagnostics.stderr.endsWith('fatal adapter failure\nfinal stderr')).toBe(true)
    expect(Buffer.byteLength(process.diagnostics.stderr)).toBeLessThanOrEqual(16384)
    expect(process.diagnostics.stderr).not.toContain('listening')
    expect(closed[0]).toEqual(process.diagnostics)
    child.stdout.destroy()
    child.stderr.destroy()
  })
})
