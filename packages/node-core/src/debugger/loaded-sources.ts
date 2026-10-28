import { createHash } from 'node:crypto'
import { realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectorProbeToken } from '../trace/program-http.js'

export type LoadedSourceEvidence = Map<string, string> & {
  scripts: Set<string>
  mapped: Set<string>
  stale: Set<string>
}
export const emptySourceEvidence = (): LoadedSourceEvidence =>
  Object.assign(new Map<string, string>(), {
    scripts: new Set<string>(),
    mapped: new Set<string>(),
    stale: new Set<string>(),
  })

/** Read-only evidence from V8, before the adapter attaches. No evaluation, pause,
 * breakpoint, or runIfWaitingForDebugger request is sent. Failure proves nothing. */
export async function loadedSourceDigests(
  port: number,
  root: string,
  signal?: AbortSignal
): Promise<LoadedSourceEvidence> {
  const digests = emptySourceEvidence()
  if (signal?.aborted) return digests
  const evidence: Promise<void>[] = []
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers: { 'x-abele-inspector-probe': inspectorProbeToken },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1500)])
        : AbortSignal.timeout(1500),
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
      const scripts = new Map<string, { path: string; map?: string }>()
      const pending = new Map<number, { path: string; map?: string }>()
      let next = 2
      let sourceBytes = 0
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        socket.close()
        done()
      }
      const timer = setTimeout(finish, 2500)
      socket.addEventListener('error', finish)
      socket.addEventListener('close', finish)
      signal?.addEventListener('abort', finish, { once: true })
      if (signal?.aborted) return finish()
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
            const { url, scriptId, sourceMapURL } = message.params
            if (typeof url !== 'string' || typeof scriptId !== 'string' || !url.startsWith('file:'))
              return
            const path = resolve(fileURLToPath(url))
            const rel = relative(root, path)
            if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
              scripts.set(scriptId, { path, map: sourceMapURL })
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
            const script = pending.get(message.id)!
            pending.delete(message.id)
            const source = message.result?.scriptSource
            if (
              typeof source === 'string' &&
              Buffer.byteLength(source) <= 8 * 1024 * 1024 &&
              (sourceBytes += Buffer.byteLength(source)) <= 32 * 1024 * 1024
            )
              evidence.push(runtimeDigests(root, script.path, source, script.map, digests))
            if (!pending.size) finish()
          }
        } catch {
          finish()
        }
      })
    })
    await Promise.all(evidence)
  } catch {
    // Inspector evidence is optional; retain timestamp/map checks when unavailable.
  }
  return digests
}

/** Inline content is evidence from the running transform, never a filename-only
 * promise about the current disk file. Do not fetch map URLs or execute loaders. */
async function runtimeDigests(
  root: string,
  script: string,
  source: string,
  mapURL: string | undefined,
  digests: LoadedSourceEvidence
) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const canonical = await realpath(script).catch(() => script)
  digests.scripts.add(canonical)
  const local = new Map<string, string>()
  // A TS URL names the original, but getScriptSource returns its generated JS.
  if (/\.[cm]?js$/.test(canonical)) local.set(canonical, hash(source))
  // An external map belongs to the disk build. It proves running source only
  // when that generated file is byte-identical to V8's loaded script.
  try {
    const url = mapURL || [...source.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)].at(-1)?.[1]
    if (url && !url.startsWith('data:') && /\.[cm]?js$/.test(canonical)) {
      const address = new URL(url, pathToFileURL(canonical))
      if (address.protocol === 'file:') {
        const mapPath = await realpath(fileURLToPath(address))
        const rel = relative(root, mapPath)
        if (
          rel &&
          rel !== '..' &&
          !rel.startsWith('..' + sep) &&
          !isAbsolute(rel) &&
          (await stat(mapPath)).size <= 8 * 1024 * 1024
        ) {
          const text = await readFile(mapPath, 'utf8')
          const mapped = await inlineSourceDigests(
            root,
            mapPath,
            '',
            'data:application/json;base64,' + Buffer.from(text).toString('base64')
          )
          const matches =
            (await stat(canonical)).size <= 8 * 1024 * 1024 &&
            hash(await readFile(canonical, 'utf8')) === hash(source)
          for (const [path, digest] of mapped) {
            if (matches) {
              local.set(path, digest)
              digests.mapped.add(path)
            } else digests.stale.add(path)
          }
        }
      }
    }
  } catch {
    // Missing or untrusted external metadata proves nothing.
  }
  for (const [path, digest] of await inlineSourceDigests(root, script, source, mapURL)) {
    digests.mapped.add(path)
    local.set(path, digest)
  }
  for (const [path, digest] of local)
    digests.set(
      path,
      digests.has(path) && digests.get(path) !== digest ? 'conflicting_runtime_sources' : digest
    )
}

export async function inlineSourceDigests(
  root: string,
  script: string,
  source: string,
  mapURL?: string
) {
  const digests = new Map<string, string>()
  try {
    const url = mapURL || [...source.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)].at(-1)?.[1]
    if (!url || url.length > 12 * 1024 * 1024) return digests
    const match = /^data:application\/json((?:;[^,]*)?),(.*)$/s.exec(url)
    if (!match) return digests
    const text = /;base64(?:;|$)/.test(match[1]!)
      ? Buffer.from(match[2]!, 'base64').toString('utf8')
      : decodeURIComponent(match[2]!)
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) return digests
    const map = JSON.parse(text)
    if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) return digests
    const base = new URL('.', pathToFileURL(script))
    const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
    const prefix = sourceRoot ? new URL(sourceRoot.replace(/\/?$/, '/'), base) : base
    for (let i = 0; i < Math.min(map.sources.length, 256); i++) {
      if (typeof map.sources[i] !== 'string' || typeof map.sourcesContent[i] !== 'string') continue
      const address = new URL(map.sources[i], prefix)
      if (address.protocol !== 'file:') continue
      const path = await realpath(fileURLToPath(address)).catch(() => undefined)
      if (!path) continue
      const rel = relative(root, path)
      if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
        digests.set(path, createHash('sha256').update(map.sourcesContent[i]).digest('hex'))
    }
  } catch {
    // Malformed maps provide no original-source identity.
  }
  return digests
}
