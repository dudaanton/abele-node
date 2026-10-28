/** The expressions a record point evaluates in the paused program to take a value whole.
 *
 * An adapter cuts long strings and opens objects a level at a time, and one DAP frame is bounded,
 * so the value is serialized inside the program once, kept under a one-off key, read back in
 * base64 chunks (no quoting an adapter could alter) and then dropped. The serializer keeps what
 * JSON loses: cycles, Map, Set, Buffer, Date, class names, undefined and functions. */

export const CAPTURE_CHUNK_CHARS = 128 * 1024
/** A value longer than this is refused rather than read for minutes with the program stopped. */
export const CAPTURE_MAX_CHARS = 64 * 1024 * 1024

const SERIALIZE = `function (v) {
  if (typeof v === 'string') return 's' + v;
  var stack = [];
  function walk(x, path) {
    if (x === undefined) return '[undefined]';
    if (typeof x === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
    if (typeof x === 'bigint') return x.toString() + 'n';
    if (typeof x === 'symbol') return x.toString();
    if (typeof x === 'number' && !isFinite(x)) return String(x);
    if (x === null || typeof x !== 'object') return x;
    if (stack.indexOf(x) >= 0) return '[Circular]';
    stack.push(x);
    try {
      var tag = Object.prototype.toString.call(x);
      if (tag === '[object Response]') {
        var headers = {};
        x.headers.forEach(function (value, key) { headers[key] = value; });
        return { '@class': 'Response', status: x.status, statusText: x.statusText, url: x.url, headers: headers };
      }
      if (tag === '[object Date]') return isNaN(x.getTime()) ? 'Invalid Date' : x.toISOString();
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(x))
        return { '[Buffer]': x.length, base64: x.length <= 65536 ? x.toString('base64') : undefined };
      if (ArrayBuffer.isView(x)) return { ['[' + x.constructor.name + ']']: x.length };
      if (tag === '[object Map]') {
        var m = [];
        x.forEach(function (val, k) { m.push([walk(k, path), walk(val, path)]); });
        return { '[Map]': m };
      }
      if (tag === '[object Set]') {
        var s = [];
        x.forEach(function (val) { s.push(walk(val, path)); });
        return { '[Set]': s };
      }
      if (tag === '[object Error]') return { '[Error]': x.name, message: x.message, stack: x.stack };
      if (Array.isArray(x)) return x.map(function (e, i) { return walk(e, path + '[' + i + ']'); });
      var o = {};
      var name = x.constructor && x.constructor.name;
      if (name && name !== 'Object') o['@class'] = name;
      Object.keys(x).forEach(function (k) {
        var val;
        try { val = x[k]; } catch (e) { val = '[Threw ' + (e && e.message) + ']'; }
        o[k] = walk(val, path + '.' + k);
      });
      return o;
    } finally {
      stack.pop();
    }
  }
  return 'j' + JSON.stringify(walk(v, '$'));
}`

/** Base64 of a binary string: the realm's own btoa when it has one, plain code otherwise. */
const BASE64 = `function (bin) {
  if (typeof btoa === 'function') return btoa(bin);
  var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', o = '';
  for (var i = 0; i < bin.length; i += 3) {
    var n = (bin.charCodeAt(i) << 16) | ((bin.charCodeAt(i + 1) || 0) << 8) | (bin.charCodeAt(i + 2) || 0);
    o += a[(n >> 18) & 63] + a[(n >> 12) & 63] + (i + 1 < bin.length ? a[(n >> 6) & 63] : '=') + (i + 2 < bin.length ? a[n & 63] : '=');
  }
  return o;
}`

/** Serializes the expression's value under `key` and answers with its length in characters. */
export function captureStart(expression: string, key: string): string {
  return `(function () { var t = globalThis.__abeleTrace || (globalThis.__abeleTrace = {}); var s = (${SERIALIZE})((${expression})); t[${JSON.stringify(key)}] = s; return String(s.length); })()`
}

/** Answers `<end>:<base64 of the characters from start to end>`; never splits a surrogate pair. */
export function captureChunk(key: string, start: number, chars = CAPTURE_CHUNK_CHARS): string {
  return `(function () { var s = globalThis.__abeleTrace[${JSON.stringify(key)}]; var e = Math.min(s.length, ${start + chars}); var c = s.charCodeAt(e - 1); if (e < s.length && c >= 0xd800 && c <= 0xdbff) e--; var p = s.slice(${start}, e); var b = typeof Buffer !== 'undefined' ? Buffer.from(p, 'utf8').toString('base64') : (${BASE64})(unescape(encodeURIComponent(p))); return e + ':' + b; })()`
}

export function captureEnd(key: string): string {
  return `(function () { if (globalThis.__abeleTrace) delete globalThis.__abeleTrace[${JSON.stringify(key)}]; return 'ok'; })()`
}

/** An adapter shows a string result quoted or not; base64 and digits survive either way. */
export function unquote(result: string): string {
  const r = result.trim()
  const q = r[0]
  if ((q === '"' || q === "'" || q === '`') && r.endsWith(q) && r.length >= 2) return r.slice(1, -1)
  return r
}

export function readLength(result: string): number {
  const n = Number(unquote(result))
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('trace_capture_invalid')
  return n
}

export function readChunk(result: string, start: number): { end: number; text: string } {
  const r = unquote(result)
  const colon = r.indexOf(':')
  const end = Number(r.slice(0, colon))
  const b64 = r.slice(colon + 1)
  if (
    colon < 1 ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)
  )
    throw new Error('trace_capture_invalid')
  return { end, text: Buffer.from(b64, 'base64').toString('utf8') }
}

/** The serialized text, without its marker, and whether it was a string to begin with. */
export function decode(serialized: string): { text: string; string: boolean } {
  if (serialized[0] === 's') return { text: serialized.slice(1), string: true }
  if (serialized[0] === 'j') return { text: serialized.slice(1), string: false }
  throw new Error('trace_capture_invalid')
}

/** `ctx.request.id as requestId` → a name and an expression. */
export function parseTake(take: string): { name: string; expression: string } {
  const m = /^([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(take.trim())
  if (m?.[1] && m[2]) return { expression: m[1].trim(), name: m[2] }
  const expression = take.trim()
  return { expression, name: expression.slice(0, 128) }
}
