import type { DatabaseSync } from 'node:sqlite'

/** Additive v12 -> v13 migration: never reinterpret provider/chat session IDs. */
export function migrateDebugger(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE debug_sessions(debug_session_id TEXT PRIMARY KEY, body TEXT NOT NULL, history_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE debug_events(debug_session_id TEXT NOT NULL REFERENCES debug_sessions(debug_session_id), event_seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(debug_session_id,event_seq));
    CREATE TABLE debug_history(debug_session_id TEXT NOT NULL REFERENCES debug_sessions(debug_session_id), history_seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(debug_session_id,history_seq));
    CREATE TABLE debug_history_payloads(debug_session_id TEXT NOT NULL, history_seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(debug_session_id,history_seq), FOREIGN KEY(debug_session_id,history_seq) REFERENCES debug_history(debug_session_id,history_seq) ON DELETE CASCADE);
    PRAGMA user_version=13;
    COMMIT;`)
}

/** Durable authority and dedup evidence are independent of evictable history. */
export function migrateDebuggerControl(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE debug_grants(grant_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE debug_policy(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE debug_operations(principal_key TEXT NOT NULL, operation_id TEXT NOT NULL, debug_session_id TEXT NOT NULL REFERENCES debug_sessions(debug_session_id), request_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal_key,operation_id));
    PRAGMA user_version=14;
    COMMIT;`)
}

/** Legacy class-based auto permission never implies blanket expression consent. */
export function migrateDebuggerModes(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    UPDATE debug_grants SET body=json_remove(json_set(body,'$.mode','ask'),'$.auto_actions')
      WHERE json_type(body,'$.auto_actions') IS NOT NULL OR json_extract(body,'$.mode')='auto';
    UPDATE debug_policy SET body=json_remove(json_set(body,'$.mode','ask'),'$.auto_actions')
      WHERE json_type(body,'$.auto_actions') IS NOT NULL OR json_extract(body,'$.mode')='auto';
    PRAGMA user_version=15;
    COMMIT;`)
}

/** Slice UTF-8 without splitting a code point or inserting replacement characters. */
export function boundedText(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  let end = bytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

/** Retain requested values only. Oversized values become an explicit inert
 * preview, not malformed JSON, live references or automatic memory capture. */
export function boundedPayload(
  value: unknown,
  bytes: number
): { json?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false }
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('invalid_debugger_payload')
  const size = Buffer.byteLength(json)
  if (size <= bytes) return { json, truncated: false }
  return {
    json: JSON.stringify({
      preview: boundedText(json, Math.floor((bytes - 128) / 6)),
      original_bytes: size,
      truncated: true,
    }),
    truncated: true,
  }
}
