import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectorProbeToken } from '../trace/program-http.js'

/** Read-only evidence from V8, before the adapter attaches. No evaluation, pause,
 * breakpoint, or runIfWaitingForDebugger request is sent. Failure proves nothing. */
export async function loadedSourceDigests(
  port: number,
  root: string
): Promise<Map<string, string>> {
  const digests = new Map<string, string>()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: { 'x-abele-inspector-probe': inspectorProbeToken },
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    })
    const reader = response.body?.getReader()
    if (!reader) return digests
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 65536) {
        await reader.cancel()
        return digests
      }
      chunks.push(Buffer.from(chunk.value))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const targets = JSON.parse(text)
    const address = Array.isArray(targets) ? targets[0]?.webSocketDebuggerUrl : undefined
    if (typeof address !== 'string') return digests
    const url = new URL(address)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port)
      return digests
    await new Promise<void>((done) => {
      const socket = new WebSocket(address)
      const scripts = new Map<string, string>()
      const pending = new Map<number, string>()
      let next = 2
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        socket.close()
        done()
      }
      const timer = setTimeout(finish, 2500)
      socket.addEventListener('error', finish)
      socket.addEventListener('close', finish)
      socket.addEventListener('open', () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Debugger.enable',
            params: { maxScriptsCacheSize: 8 * 1024 * 1024 },
          })
        )
      )
      socket.addEventListener('message', (event) => {
        try {
          if (finished || typeof event.data !== 'string' || event.data.length > 16 * 1024 * 1024)
            return finish()
          const message = JSON.parse(event.data)
          if (message.method === 'Debugger.scriptParsed' && scripts.size < 256) {
            const { url, scriptId } = message.params
            if (typeof url !== 'string' || typeof scriptId !== 'string' || !url.startsWith('file:'))
              return
            const path = resolve(fileURLToPath(url))
            const rel = relative(root, path)
            if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
              scripts.set(scriptId, path)
          } else if (message.id === 1) {
            for (const [scriptId, path] of scripts) {
              const id = next++
              pending.set(id, path)
              socket.send(
                JSON.stringify({ id, method: 'Debugger.getScriptSource', params: { scriptId } })
              )
            }
            if (!pending.size) finish()
          } else if (pending.has(message.id)) {
            const path = pending.get(message.id)!
            pending.delete(message.id)
            const source = message.result?.scriptSource
            if (typeof source === 'string' && Buffer.byteLength(source) <= 8 * 1024 * 1024)
              digests.set(path, createHash('sha256').update(source).digest('hex'))
            if (!pending.size) finish()
          }
        } catch {
          finish()
        }
      })
    })
  } catch {
    // Inspector evidence is optional; retain timestamp/map checks when unavailable.
  }
  return digests
}
