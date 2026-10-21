import { expect, it } from 'vitest'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'

it('keeps an Obsidian MCP call open past the bridge deadline and carries a stable call identity', async () => {
  const socket = resolve(`.ot-${randomUUID().slice(0, 8)}.sock`)
  const requests: any[] = []
  const server = createServer((connection) => {
    let buffer = ''
    connection.on('data', (chunk) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const p = JSON.parse(buffer.split('\n')[0]!)
      requests.push(p)
      // The child scales its old 65-second timeout to 5 ms. The server's
      // independent clock simulates an owner returning after that deadline.
      setTimeout(
        () =>
          connection.end(
            JSON.stringify({ state: 'succeeded', result: { text: 'created' } }) + '\n'
          ),
        30
      )
    })
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(socket, done)
  })
  const bootstrap =
    'const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms>=60000?5:ms,...args)'
  const child = spawn(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(bootstrap),
      resolve('packages/provider-claude/dist/debugger-bridge.js'),
    ],
    {
      env: {
        ...process.env,
        ABELE_APPROVAL_SOCKET: socket,
        ABELE_APPROVAL_TOKEN: 'test',
        ABELE_SESSION_ID: 'session',
        ABELE_RUN_ID: 'run',
        ABELE_GENERATION: 'generation',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  const exited = new Promise<void>((done) => child.once('close', () => done()))
  try {
    const response = new Promise<any>((done, reject) => {
      let buffer = ''
      child.once('error', reject)
      child.stdout.on('data', (b) => {
        buffer += b
        if (buffer.includes('\n')) done(JSON.parse(buffer.split('\n')[0]!))
      })
    })
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'obsidian_create', arguments: { path: 'note' } },
      }) + '\n'
    )
    const result = await response
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ state: 'succeeded' })
    expect(requests[0]).toMatchObject({
      name: 'obsidian_create',
      session_id: 'session',
      run_id: 'run',
    })
    expect(requests[0].call_id).toMatch(/^claude:[a-f0-9]{64}$/)
  } finally {
    child.stdin.end()
    child.kill()
    await exited
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(socket, { force: true })
  }
})
