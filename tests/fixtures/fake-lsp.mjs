import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
let buffer = Buffer.alloc(0)
const source = process.argv[2]
const log = process.argv[3]
const uriRoot = process.argv[4]
let rootUri
const documents = new Map()
const documentUri = (uri) =>
  uriRoot && uri.startsWith(rootUri + '/') ? uriRoot + uri.slice(rootUri.length) : uri
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  process.stdout.write(frame.slice(0, 9))
  process.stdout.write(frame.slice(9))
}
process.stdin.on('data', (bytes) => {
  buffer = Buffer.concat([buffer, bytes])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const m = JSON.parse(buffer.subarray(end + 4, end + 4 + length))
    buffer = buffer.subarray(end + 4 + length)
    if (m.id === 'config' && m.result && log)
      writeFileSync(log + '.configuration', JSON.stringify(m.result))
    if (log && m.method) appendFileSync(log, m.method + '\n')
    if (m.method === 'initialize') {
      if (source === 'initialize-wait') continue
      rootUri = m.params.rootUri
      if (log) writeFileSync(log + '.initialize', JSON.stringify(m.params))
      if (source === 'crash' && !existsSync(log + '.crashed')) {
        writeFileSync(log + '.crashed', '1')
        process.exit(1)
      }
      send({
        id: m.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            ...(source === 'pull' ? { diagnosticProvider: { identifier: 'fixture' } } : {}),
          },
        },
      })
      send({ id: 'config', method: 'workspace/configuration', params: { items: [{}] } })
    } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
      if (source === 'pull') {
        documents.set(
          m.params.textDocument.uri,
          m.params.textDocument.text ?? m.params.contentChanges[0].text
        )
        if (m.method === 'textDocument/didChange')
          send({ id: 'refresh', method: 'workspace/diagnostic/refresh', params: {} })
        continue
      }
      send({
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: documentUri(m.params.textDocument.uri),
          version: m.params.textDocument.version,
          diagnostics: [{ range, message: 'Ошибка 🐛', source: 'untrusted', severity: 1 }],
        },
      })
    } else if (m.method === 'textDocument/diagnostic') {
      const reply = {
        id: m.id,
        result: {
          kind: 'full',
          items: [
            {
              range,
              message: 'pulled diagnostic',
              severity: 1,
              code: documents.get(m.params.textDocument.uri) ?? 'fixture',
            },
          ],
        },
      }
      setTimeout(() => send(reply), Number(process.argv[5]) || 0)
    } else if (m.method === 'textDocument/definition') {
      send({
        id: m.id,
        result: [
          { uri: documentUri(m.params.textDocument.uri), range },
          { uri: pathToFileURL('/outside/secret.ts').href, range },
        ],
      })
    } else if (m.method === 'echo') send({ id: m.id, result: m.params })
    else if (m.method === 'exit') process.exit(0)
    else if (m.method === 'crash') {
      process.stderr.write('Error: fixture failure token=private-value\n', () => process.exit(1))
    } else if (m.method === 'workerCrash') {
      send({
        method: 'window/logMessage',
        params: {
          type: 1,
          message:
            '[lspserver] [tsclient] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        },
      })
      send({
        method: 'window/logMessage',
        params: {
          type: 1,
          message: '[lspserver] [tsclient] [tsserver] Exited. Code: null. Signal: SIGABRT',
        },
      })
    } else if (m.id !== undefined && m.method !== 'wait') send({ id: m.id, result: null })
  }
})
