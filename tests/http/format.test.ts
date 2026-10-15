import { describe, expect, it } from 'vitest'
import { parseRequestFile, writeRequestFile } from '../../packages/node-core/src/http/format.js'
import type { HttpRequestDoc } from '../../packages/node-protocol/src/http.js'

const order: HttpRequestDoc = {
  name: 'Create order',
  method: 'POST',
  url: '{{base}}/orders',
  params: [
    { key: 'limit', value: '10' },
    { key: 'q', value: 'a b&c' },
    { key: 'debug', value: '1', off: true },
  ],
  headers: [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Authorization', value: 'Bearer ${abele_key:shop}' },
    { key: 'X-Trace', value: 'on', off: true },
  ],
  body: { format: 'json', text: '{\n  "qty": 2\n}' },
  scripts: { before: 'Sign request', after: 'Keep token' },
  checks: ['status == 201'],
}

describe('a saved request as a .http file', () => {
  it('reads like a .http file and comes back the same', () => {
    const text = writeRequestFile(order)
    expect(text).toBe(
      [
        '# @name Create order',
        '# @before Sign request',
        '# @after Keep token',
        '# @check status == 201',
        '# @off-param debug=1',
        '# @off-header X-Trace: on',
        'POST {{base}}/orders?limit=10&q=a%20b%26c',
        'Content-Type: application/json',
        'Authorization: Bearer ${abele_key:shop}',
        '',
        '{',
        '  "qty": 2',
        '}',
        '',
      ].join('\n')
    )
    expect(parseRequestFile(text, 'Fallback')).toEqual({
      ...order,
      // Lines left out follow the ones sent.
      params: order.params,
    })
  })

  it('takes a plain .http file written by hand', () => {
    const doc = parseRequestFile(
      '### list\nGET https://example.test/items?page=2 HTTP/1.1\nAccept: application/json\n',
      'List items'
    )
    expect(doc).toEqual({
      name: 'List items',
      method: 'GET',
      url: 'https://example.test/items',
      params: [{ key: 'page', value: '2' }],
      headers: [{ key: 'Accept', value: 'application/json' }],
      scripts: {},
      checks: [],
    })
  })

  it('keeps a body that is not JSON as text and a form as a form', () => {
    const form = parseRequestFile(
      'POST https://example.test/login\nContent-Type: application/x-www-form-urlencoded\n\nuser=a&pass=b',
      'Login'
    )
    expect(form.body).toEqual({ format: 'form', text: 'user=a&pass=b' })
    const plain = parseRequestFile('PUT https://example.test/note\n\nhello', 'Note')
    expect(plain.body).toEqual({ format: 'text', text: 'hello' })
    expect(parseRequestFile(writeRequestFile(plain), 'Note').body).toEqual(plain.body)
  })

  it('keeps every field above the body on its own line, whatever it holds', () => {
    const text = writeRequestFile({
      ...order,
      name: 'Sneaky\nPOST https://elsewhere.test/',
      url: '{{base}}/x\nX-Injected: 1',
      scripts: { before: 'Sign\r\nDELETE https://elsewhere.test/' },
      headers: [{ key: 'X-A\nX-B', value: 'v\r\nX-C: 2' }],
      checks: ['status == 201\nGET https://elsewhere.test/'],
    })
    const back = parseRequestFile(text, 'x')
    expect(back.method).toBe('POST')
    expect(back.url).toBe('{{base}}/x%20X-Injected:%201')
    expect(back.headers.map((h) => h.key)).toEqual(['X-A X-B'])
    expect(text.split('\n').filter((l) => /^(GET|POST|DELETE) /.test(l))).toHaveLength(1)
  })

  it('reads an unknown method or an empty file as a GET with no address', () => {
    expect(parseRequestFile('', 'Empty')).toMatchObject({ method: 'GET', url: '', name: 'Empty' })
  })
})
