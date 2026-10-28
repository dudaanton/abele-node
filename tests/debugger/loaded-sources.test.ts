import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { loadedSourceDigests } from '../../packages/node-core/src/debugger/loaded-sources.js'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
it('proves external maps by loaded build bytes and identifies a replaced build', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'external-map-')))
  dirs.push(root)
  const script = join(root, 'app.js'),
    path = join(root, 'app.ts')
  writeFileSync(path, 'const n: number = 1')
  writeFileSync(script, 'const n = 1')
  writeFileSync(
    script + '.map',
    JSON.stringify({ sources: ['app.ts'], sourcesContent: ['const n: number = 1'] })
  )
  inspector([
    { url: pathToFileURL(script).href, source: 'const n = 1', sourceMapURL: 'app.js.map' },
  ])
  expect((await loadedSourceDigests(9229, root)).get(path)).toBe(hash('const n: number = 1'))
  writeFileSync(script, 'const n = 2')
  const stale = await loadedSourceDigests(9229, root)
  expect(stale.has(path)).toBe(false)
  expect(stale.stale.has(path)).toBe(true)
})
function inspector(scripts: { url: string; source: string; sourceMapURL?: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify([{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/fixture' }]))
    )
  )
  class Socket extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    close() {}
    send(text: string) {
      const request = JSON.parse(text)
      queueMicrotask(() => {
        const send = (value: object) =>
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
        if (request.method === 'Debugger.enable') {
          scripts.forEach((script, i) =>
            send({ method: 'Debugger.scriptParsed', params: { ...script, scriptId: String(i) } })
          )
          send({ id: request.id, result: {} })
        } else
          send({
            id: request.id,
            result: { scriptSource: scripts[Number(request.params.scriptId)]!.source },
          })
      })
    }
  }
  vi.stubGlobal('WebSocket', Socket)
}

it.each(['tsx', 'ts-node'])(
  'reads original %s inline content, including nested packages and file URLs',
  async (loader) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'inline-map-')))
    dirs.push(root)
    const path = join(root, 'packages/service/src/index.ts')
    mkdirSync(dirname(path), { recursive: true })
    const original = 'import { value } from "./value.js"; const n: number = value\n'
    writeFileSync(path, original)
    const map = {
      version: 3,
      sources: [loader === 'tsx' ? path : pathToFileURL(path).href],
      sourcesContent: [original],
      mappings: '',
    }
    const url =
      'data:application/json;charset=utf-8;base64,' +
      Buffer.from(JSON.stringify(map)).toString('base64')
    inspector([
      {
        url: pathToFileURL(path).href,
        source: 'const n = value;\n//# sourceMappingURL=' + url,
        sourceMapURL: url,
      },
    ])
    const digests = await loadedSourceDigests(9229, root)
    expect(digests.get(path)).toBe(hash(original))
    writeFileSync(path, original + '// changed')
    expect(digests.get(path)).not.toBe(hash(original + '// changed'))
  }
)

it('canonicalizes relative sourceRoot paths and never trusts missing content or outside sources', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inline-map-')))
  dirs.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/main.ts'), 'original')
  symlinkSync(join(root, 'src'), join(root, 'linked'))
  const url =
    'data:application/json,' +
    encodeURIComponent(
      JSON.stringify({
        version: 3,
        sourceRoot: '../linked',
        sources: ['main.ts', '../../../outside.ts', 'missing.ts'],
        sourcesContent: ['original', 'secret', null],
      })
    )
  inspector([
    { url: pathToFileURL(join(root, 'dist/main.js')).href, source: 'compiled', sourceMapURL: url },
  ])
  expect(await loadedSourceDigests(9229, root)).toEqual(
    new Map([
      [join(root, 'dist/main.js'), hash('compiled')],
      [join(root, 'src/main.ts'), hash('original')],
    ])
  )
})

it('keeps a loaded TS script without an inline map distinct from an unloaded candidate', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inline-map-')))
  dirs.push(root)
  const path = join(root, 'main.ts')
  writeFileSync(path, 'const n: number = 1')
  inspector([{ url: pathToFileURL(path).href, source: 'const n = 1' }])
  const evidence = await loadedSourceDigests(9229, root)
  expect(evidence.has(path)).toBe(false)
  expect(evidence.scripts.has(path)).toBe(true)
  expect(evidence.mapped.size).toBe(0)
})

it('does not choose a matching version when V8 has conflicting originals for the same path', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inline-map-')))
  dirs.push(root)
  const path = join(root, 'main.ts')
  writeFileSync(path, 'original')
  inspector(
    ['original', 'changed'].map((text) => ({
      url: pathToFileURL(path).href,
      source: 'generated',
      sourceMapURL:
        'data:application/json;base64,' +
        Buffer.from(JSON.stringify({ sources: ['main.ts'], sourcesContent: [text] })).toString(
          'base64'
        ),
    }))
  )
  const evidence = await loadedSourceDigests(9229, root)
  expect(evidence.get(path)).not.toBe(hash('original'))
  expect(evidence.get(path)).not.toBe(hash('changed'))
})
