import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import {
  installProgramHttp,
  type ProgramHttpEvent,
} from '../../packages/node-core/src/trace/program-http.js'

it('keeps server and sink traffic in their own processes and identifies both directions', async () => {
  const children: ChildProcess[] = []
  const start = async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import http from 'node:http';
      const capture = (${installProgramHttp.toString()})();
      const server = http.createServer(async (req, res) => {
        if (req.url.startsWith('/proxy')) {
          const target = new URL(req.url, 'http://localhost').searchParams.get('target');
          const response = await fetch(target);
          res.end(await response.text());
        } else res.end('sink');
      }).listen(0, '127.0.0.1', () => process.send({port: server.address().port}));
      process.on('message', () => {
        const events = [];
        for (;;) { const batch = capture.drain(); if (!batch.length) break; events.push(...batch); }
        process.send({events});
      });
    `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    children.push(child)
    const [message] = await once(child, 'message')
    return { child, url: `http://127.0.0.1:${message.port}` }
  }
  const drain = async (child: ChildProcess): Promise<ProgramHttpEvent[]> => {
    const reply = once(child, 'message')
    child.send('drain')
    return (await reply)[0].events
  }
  try {
    const server = await start()
    const sink = await start()
    expect(await (await fetch(`${sink.url}/direct`)).text()).toBe('sink')
    expect(
      await (
        await fetch(`${server.url}/proxy?target=${encodeURIComponent(`${sink.url}/forwarded`)}`)
      ).text()
    ).toBe('sink')
    await new Promise((r) => setTimeout(r, 50))
    const serverEvents = await drain(server.child)
    const sinkEvents = await drain(sink.child)
    expect(serverEvents).toHaveLength(2)
    expect(serverEvents.some((e) => e.url === `${sink.url}/direct`)).toBe(false)
    expect(serverEvents.find((e) => e.url === `${sink.url}/forwarded`)).toMatchObject({
      direction: 'outgoing',
    })
    expect(serverEvents.find((e) => e.url.startsWith(`${server.url}/proxy`))).toMatchObject({
      direction: 'incoming',
    })
    expect(sinkEvents).toHaveLength(2)
    expect(sinkEvents.every((e) => e.direction === 'incoming')).toBe(true)
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      })
    )
  }
})
