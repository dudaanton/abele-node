import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createEchoServer } from './echo-server.mjs'

test('disposable server accepts native ws echo and CORS HTTP fetch', async () => {
  const server = createEchoServer(() => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/echo?message=hello`)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.equal(await response.text(), 'hello')
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await once(ws, 'open')
    for (const message of ['abele-stage0-echo', 'x'.repeat(200)]) {
      const received = once(ws, 'message')
      ws.send(message)
      assert.equal((await received)[0].data, message)
    }
    const closed = once(ws, 'close')
    ws.close()
    await closed
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
