import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ChannelError,
  LIMITS,
  type JournalEvent,
  type AuthorityContext,
} from '@abele/channel-protocol'
import {
  validateParams,
  PairingMethodSchemas,
  NodeEventSchema,
  MUTATIONS,
  type Method,
  SessionSchema,
  DelegationGrantSchema,
  DelegationAuthoritySchema,
  type DelegationGrant,
  PromptSchema,
  InputStateSchema,
  FakeStepSchema,
  FAKE_CAPABILITIES,
  type Prompt,
  type FakeStep,
} from '@abele/node-protocol'

import { canonicalStateDir } from './state.js'
export { canonicalStateDir } from './state.js'
export { acquireUpdateLock } from './update-lock.js'
import { ResourceServices } from './resources.js'
import { DelegationService } from './delegation.js'
export { DelegationService, DelegationMailbox, WorkerReporter } from './delegation.js'
import { PairingService } from './pairing.js'
export { PairingService, IdentityStore } from './pairing.js'
import { ProviderSessions } from './claude.js'
import type { ProviderAdapter } from './providers.js'
export type { ProviderAdapter } from './providers.js'
export { PiProviderAdapter } from '@abele/provider-pi'
export { ClaudeProviderAdapter } from '@abele/provider-claude'
export {
  ResourceServices,
  ProjectService,
  WorkspaceService,
  JobService,
  JobReconciler,
  type WorkspaceLease,
} from './resources.js'
export { GitRunner, type GitCommand } from './git.js'
export { FileMutationCoordinator } from './mutations.js'
export {
  WorkspaceFileService,
  GitViewService,
  DiffSnapshotStore,
  ReviewBatchService,
} from './files.js'

type Row = Record<string, string | number | null>
const nodeActor = { kind: 'node' } as const
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
/** All current local installations own all resources, but every boundary rechecks revocation. */
export class AuthorityService {
  constructor(private db: DatabaseSync) {}
  authenticate(token: string): AuthorityContext {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ChannelError('unauthorized')
    const row = this.db
      .prepare('SELECT installation_id FROM installations WHERE token_hash=? AND revoked=0')
      .get(digest(token)) as Row | undefined
    if (!row) throw new ChannelError('unauthorized')
    return { installation_id: String(row.installation_id), profile: 'local-token-v1' }
  }
  /** Resolve an installation's current controller authority, retaining the exact paired key. */
  forInstallation(installation_id: string): AuthorityContext {
    const paired = this.db
      .prepare('SELECT public_key FROM paired_devices WHERE installation_id=?')
      .get(installation_id) as Row | undefined
    const actor: AuthorityContext = paired
      ? { installation_id, profile: 'paired-wss-v1', device_key: String(paired.public_key) }
      : { installation_id, profile: 'local-token-v1' }
    this.check(actor, 'retain_authority')
    return actor
  }
  snapshot(actor: AuthorityContext) {
    const explicit = actor.profile ? actor : this.forInstallation(actor.installation_id)
    this.check(explicit, 'retain_authority')
    return DelegationAuthoritySchema.parse(explicit)
  }
  /** Inside the device-revocation transaction: a later claim of the same key cannot revive grants. */
  invalidatePairedGrants(installation_id?: string) {
    this.db
      .prepare(
        `UPDATE delegation_grants SET body=json_set(body,'$.revoked',json('true'))
      WHERE (json_extract(body,'$.owner_authority.profile')='paired-wss-v1' AND (? IS NULL OR json_extract(body,'$.approved_by')=?))
         OR (json_extract(body,'$.controller_authority.profile')='paired-wss-v1' AND (? IS NULL OR json_extract(body,'$.installation_id')=?))`
      )
      .run(
        installation_id ?? null,
        installation_id ?? null,
        installation_id ?? null,
        installation_id ?? null
      )
  }
  checkGrant(grant: DelegationGrant) {
    const retained = (id: string, saved?: AuthorityContext) => {
      if (saved) {
        if (saved.installation_id !== id) throw new ChannelError('unauthorized')
        this.check(saved, 'delegation_authority')
      } else {
        // Legacy grants never recorded a paired key. Do not guess which device approved them,
        // or revive an old approval after re-enrollment; require a new explicit approval.
        if (this.db.prepare('SELECT 1 FROM paired_devices WHERE installation_id=?').get(id))
          throw new ChannelError('unauthorized')
        this.check({ installation_id: id, profile: 'local-token-v1' }, 'delegation_authority')
      }
    }
    if (grant.revoked) throw new ChannelError('unauthorized')
    retained(grant.approved_by, grant.owner_authority)
    retained(grant.installation_id, grant.controller_authority)
  }
  check(actor: AuthorityContext, _action: string, _resource?: string): void {
    if (
      !this.db
        .prepare('SELECT 1 FROM installations WHERE installation_id=? AND revoked=0')
        .get(actor.installation_id)
    )
      throw new ChannelError('unauthorized')
    if (_resource) {
      const mailbox = this.db
        .prepare('SELECT principal_id,grant_id FROM delegations WHERE mailbox_stream_id=?')
        .get(_resource) as Row | undefined
      if (mailbox) {
        const grant = this.db
          .prepare('SELECT body FROM delegation_grants WHERE grant_id=?')
          .get(String(mailbox.grant_id)) as Row
        const body = DelegationGrantSchema.parse(JSON.parse(String(grant.body)))
        if (
          mailbox.principal_id !== actor.installation_id ||
          body.revoked ||
          !body.actions.includes('read')
        )
          throw new ChannelError('unauthorized')
        this.checkGrant(body)
      }
    }
    if (
      actor.profile === 'paired-wss-v1' &&
      (!actor.device_key ||
        !this.db
          .prepare(
            "SELECT 1 FROM paired_devices WHERE installation_id=? AND public_key=? AND state='confirmed'"
          )
          .get(actor.installation_id, actor.device_key))
    )
      throw new ChannelError('unauthorized')
  }
}
export interface JournalStore {
  read(stream: string, after: number, limit?: number): JournalEvent[]
}
export interface OperationStore {
  request(actor: AuthorityContext, method: string, params: unknown, operation?: string): unknown
}
export interface SessionQueue {
  tick(now?: number): void
}
export interface PromptService {
  prompts(session: string): Prompt[]
}
export class FakeProvider {
  capabilities() {
    return FAKE_CAPABILITIES
  }
  validate(script: unknown): FakeStep[] {
    if (!Array.isArray(script)) throw new Error('invalid_script')
    return script.map((s) => FakeStepSchema.parse(s))
  }
}
export class NodeCore implements JournalStore, OperationStore, SessionQueue, PromptService {
  readonly db: DatabaseSync
  readonly stateDir: string
  readonly authority: AuthorityService
  readonly pairing: PairingService
  readonly node_id: string
  readonly provider = new FakeProvider()
  readonly resources: ResourceServices
  readonly delegations: DelegationService
  readonly execution: ProviderSessions
  /** Compatibility alias; both providers share this dispatcher. */
  readonly claude: ProviderSessions
  fault?: (point: 'before_commit' | 'after_commit') => void
  private closed = false
  private storageFailed = false
  constructor(
    stateDir: string,
    options: { worktreeRoot?: string; claude?: ProviderAdapter; pi?: ProviderAdapter } = {}
  ) {
    stateDir = this.stateDir = canonicalStateDir(stateDir)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    chmodSync(stateDir, 0o700)
    this.db = new DatabaseSync(join(stateDir, 'node.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;'
    )
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    if (version > 11) {
      this.db.close()
      throw new Error('unsupported_database_version')
    }
    if (version === 0)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE installations(installation_id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE streams(stream_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL DEFAULT 0 CHECK(head_seq>=0 AND head_seq<=9007199254740991));
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY REFERENCES streams(stream_id), body TEXT NOT NULL);
      CREATE TABLE events(stream_id TEXT REFERENCES streams(stream_id), seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(stream_id,seq));
      CREATE TABLE operations(principal_id TEXT REFERENCES installations(installation_id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id));
      CREATE TABLE inputs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, input_id TEXT UNIQUE NOT NULL, session_id TEXT REFERENCES sessions(session_id), principal_id TEXT REFERENCES installations(installation_id), state TEXT NOT NULL, body TEXT NOT NULL, run_id TEXT, step INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE prompts(prompt_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(session_id), run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(session_id), content BLOB NOT NULL);
      INSERT INTO streams(stream_id) VALUES('catalog');
      PRAGMA user_version=1; COMMIT;`)
    if (version < 2)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE projects(project_id TEXT PRIMARY KEY, root_path TEXT UNIQUE NOT NULL, body TEXT NOT NULL, registered INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE jobs(job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE workspace_leases(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id), session_id TEXT UNIQUE NOT NULL REFERENCES sessions(session_id));
      PRAGMA user_version=2; COMMIT;`)
    if (version < 3)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE provider_runs(run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), state TEXT NOT NULL, processes TEXT NOT NULL DEFAULT '[]', ipc_path TEXT);
      CREATE INDEX prompts_session ON prompts(session_id,prompt_id);
      CREATE INDEX prompts_run ON prompts(run_id);
      PRAGMA user_version=3; COMMIT;`)
    if (version < 4)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE prompt_deliveries(prompt_id TEXT PRIMARY KEY REFERENCES prompts(prompt_id), reservation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','consumed')));
      PRAGMA user_version=4; COMMIT;`)
    if (version < 5)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE workspace_contents(workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), content_id TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(workspace_id,content_id));
      CREATE TABLE diff_snapshots(diff_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), body TEXT NOT NULL);
      PRAGMA user_version=5; COMMIT;`)
    if (version < 6)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE file_mutations(principal_id TEXT NOT NULL REFERENCES installations(installation_id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id));
      PRAGMA user_version=6; COMMIT;`)
    if (version < 7)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE file_recoveries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), path TEXT NOT NULL, content_id TEXT NOT NULL, fingerprint TEXT NOT NULL, protected INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id,path));
      PRAGMA user_version=7; COMMIT;`)
    if (version < 8)
      this.db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE file_recoveries RENAME TO legacy_file_recoveries;
      CREATE TABLE file_recovery_copies(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), path TEXT UNIQUE NOT NULL, file_path TEXT NOT NULL, content_id TEXT NOT NULL, size INTEGER NOT NULL, legacy_path TEXT);
      PRAGMA user_version=8; COMMIT;`)
    if (version < 9) {
      const legacy = this.db
        .prepare('SELECT ordinal,workspace_id,path FROM legacy_file_recoveries')
        .all()
        .map((row) => ({ table: 'legacy_file_recoveries', ...row }))
      const pending = this.db
        .prepare('SELECT principal_id,operation_id,body FROM file_mutations')
        .all() as { principal_id: string; operation_id: string; body: string }[]
      const oldIntents = pending.flatMap((row) => {
        let body: {
          kind?: string
          params?: { path?: string }
          backup?: string
          temporary?: string
        } = {}
        try {
          body = JSON.parse(row.body)
        } catch {
          /* malformed intent also requires inspection */
        }
        return body?.kind === 'in_place'
          ? []
          : [
              {
                table: 'file_mutations',
                principal_id: row.principal_id,
                operation_id: row.operation_id,
                paths: [body?.params?.path, body?.backup, body?.temporary].filter(Boolean),
              },
            ]
      })
      if (legacy.length || oldIntents.length) {
        this.db.close()
        throw new Error(
          'Legacy recovery state requires manual inspection before startup: ' +
            JSON.stringify([...legacy, ...oldIntents])
        )
      }
      this.db.exec(
        'BEGIN IMMEDIATE; DROP TABLE legacy_file_recoveries; PRAGMA user_version=9; COMMIT;'
      )
    }
    if (version < 10)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE provider_native_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), provider TEXT NOT NULL CHECK(provider='pi'), native_session_id TEXT NOT NULL, session_file TEXT UNIQUE NOT NULL);
      INSERT INTO provider_native_sessions SELECT session_id,'pi',json_extract(body,'$.native_session_id'),json_extract(body,'$.native_session_file') FROM sessions WHERE json_extract(body,'$.provider')='pi' AND json_extract(body,'$.native_session_file') IS NOT NULL;
      PRAGMA user_version=10; COMMIT;`)
    if (version < 11)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE delegation_grants(grant_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE delegations(delegation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES installations(installation_id), delegation_key TEXT NOT NULL, request_hash TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES delegation_grants(grant_id), session_id TEXT UNIQUE NOT NULL REFERENCES sessions(session_id), mailbox_stream_id TEXT UNIQUE NOT NULL REFERENCES streams(stream_id), body TEXT NOT NULL, create_receipt TEXT NOT NULL, result_text TEXT, UNIQUE(principal_id,delegation_key));
      CREATE TABLE delegation_reports(delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id), run_id TEXT NOT NULL, report_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(delegation_id,run_id,report_id));
      PRAGMA user_version=11; COMMIT;`)
    const identity = this.db.prepare("SELECT value FROM meta WHERE key='node_id'").get() as
      Row | undefined
    this.node_id = identity ? String(identity.value) : randomUUID()
    if (!identity) this.db.prepare("INSERT INTO meta VALUES('node_id',?)").run(this.node_id)
    this.authority = new AuthorityService(this.db)
    this.pairing = new PairingService(this)
    this.delegations = new DelegationService(this)
    try {
      this.resources = new ResourceServices(this, options.worktreeRoot)
      this.resources.mutations.recover()
    } catch (error) {
      this.db.close()
      throw error
    }
    this.transaction(() => {
      this.delegations.repairLeases()
      const active = this.db
        .prepare("SELECT * FROM inputs WHERE state IN ('dispatching','delivered')")
        .all() as Row[]
      for (const input of active) {
        this.transition(input, 'delivery_unknown')
        this.append(String(input.session_id), 'run.interrupted', nodeActor, {
          run_id: input.run_id,
          reason: 'daemon_restart',
        })
      }
      for (const row of this.db
        .prepare("SELECT body FROM prompts WHERE json_extract(body,'$.state')='pending'")
        .all() as Row[]) {
        const prompt = PromptSchema.parse(JSON.parse(String(row.body)))
        this.resolvePrompt(prompt, 'invalidated', 'deny', null)
      }
    })
    this.execution = new ProviderSessions(this, options.claude, options.pi)
    this.claude = this.execution
    this.protectFiles()
  }
  protectFiles() {
    for (const file of readdirSync(this.stateDir))
      if (file.startsWith('node.sqlite')) chmodSync(join(this.stateDir, file), 0o600)
  }
  close() {
    if (!this.closed) {
      this.protectFiles()
      this.db.close()
      this.closed = true
    }
  }
  createToken(label: string) {
    if (!label || label.length > 128) throw new Error('invalid_label')
    const token = randomBytes(32).toString('hex'),
      installation_id = randomUUID()
    this.db
      .prepare('INSERT INTO installations(installation_id,label,token_hash) VALUES(?,?,?)')
      .run(installation_id, label, digest(token))
    this.protectFiles()
    return { installation_id, token }
  }
  listTokens() {
    return this.db.prepare('SELECT installation_id,label,revoked FROM installations').all()
  }
  revokeToken(id: string) {
    this.db.prepare('UPDATE installations SET revoked=1 WHERE installation_id=?').run(id)
  }
  /** Synchronous state/receipt/event commit only; Git effects must stay outside. */
  transaction<T>(work: () => T, inject = false): T {
    if (this.storageFailed) throw new ChannelError('storage_unavailable')
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = work()
      if (inject) this.fault?.('before_commit')
      this.db.exec('COMMIT')
    } catch (error) {
      if (!(error instanceof ChannelError)) this.storageFailed = true
      // SQLITE_FULL/IOERR can automatically roll back. Preserve the original cause
      // and fence execution even when there is no transaction left to roll back.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        this.storageFailed = true
      }
      throw error
    }
    this.protectFiles()
    if (inject) this.fault?.('after_commit')
    return result
  }
  append(stream: string, type: string, actor: JournalEvent['actor'], data: unknown) {
    const row = this.db
      .prepare('UPDATE streams SET head_seq=head_seq+1 WHERE stream_id=? RETURNING head_seq')
      .get(stream) as Row | undefined
    if (!row) throw new ChannelError('not_found')
    const event = NodeEventSchema.parse({
      kind: 'event',
      node_id: this.node_id,
      stream_id: stream,
      seq: Number(row.head_seq),
      type,
      actor,
      at: new Date().toISOString(),
      data,
    })
    if (Buffer.byteLength(JSON.stringify(event)) > LIMITS.record_bytes)
      throw new ChannelError('record_too_large')
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?)')
      .run(stream, event.seq, JSON.stringify(event))
    return event
  }
  head(stream: string): number {
    const row = this.db.prepare('SELECT head_seq FROM streams WHERE stream_id=?').get(stream) as
      Row | undefined
    if (!row) throw new ChannelError('not_found')
    return Number(row.head_seq)
  }
  read(stream: string, after: number, limit: number = LIMITS.page_events): JournalEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || limit < 1 || limit > 256)
      throw new ChannelError('invalid_params')
    if (after > this.head(stream)) throw new ChannelError('resync_required')
    const rows = this.db
      .prepare('SELECT body FROM events WHERE stream_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(stream, after, limit) as Row[]
    let bytes = 0
    return rows
      .map((r) => NodeEventSchema.parse(JSON.parse(String(r.body))))
      .filter((e) => {
        bytes += Buffer.byteLength(JSON.stringify(e)) + 1
        return bytes <= Math.min(LIMITS.page_bytes, LIMITS.record_bytes - 1024)
      })
  }
  capabilities() {
    const claude = this.claude.capabilities()
    return {
      ...this.provider.capabilities(),
      provider: 'node',
      provider_version: '5',
      providers: [this.provider.capabilities(), claude, this.claude.capabilities('pi')],
      capabilities: {
        ...this.provider.capabilities().capabilities,
        workspace_files: { status: 'supported', evidence: 'bounded-no-follow-files-v1' },
        workspace_editing: { status: 'supported', evidence: 'preconditioned-in-place-writes-v2' },
        immutable_diffs: { status: 'supported', evidence: 'persisted-patch-snapshots-v1' },
        review_batches: { status: 'supported', evidence: 'validated-idempotent-input-v1' },
        delegation: { status: 'supported', evidence: 'durable-granted-mailbox-v1' },
        worker_reporting: {
          status: 'supported',
          evidence: 'structured-final-message-adapter-v1; provider embedding report tool',
        },
        execution:
          this.claude.available || this.claude.isAvailable('pi')
            ? {
                status: 'supported',
                evidence:
                  'shared-supervised-providers-v1; inspect per-provider compatibility gates',
              }
            : this.provider.capabilities().capabilities.execution,
      },
    }
  }
  prompt(id: string): Prompt {
    const row = this.db.prepare('SELECT body FROM prompts WHERE prompt_id=?').get(id) as
      Row | undefined
    if (!row) throw new ChannelError('not_found')
    return PromptSchema.parse(JSON.parse(String(row.body)))
  }
  prompts(session: string): Prompt[] {
    this.head(session)
    return (
      this.db.prepare('SELECT body FROM prompts WHERE session_id=?').all(session) as Row[]
    ).map((r) => PromptSchema.parse(JSON.parse(String(r.body))))
  }
  request(actor: AuthorityContext, method: string, raw: unknown, operation?: string): unknown {
    this.authority.check(actor, 'request')
    if (method === 'pairing.list' || method === 'pairing.confirm') {
      if (actor.profile !== 'local-token-v1') throw new ChannelError('local_owner_required')
      const parsed = PairingMethodSchemas[method].safeParse(raw)
      if (!parsed.success) throw new ChannelError('invalid_params')
      if (method === 'pairing.list') return this.pairing.list()
      const p = parsed.data as { installation_id: string; device_fingerprint: string }
      return this.pairing.confirm(p.installation_id, p.device_fingerprint)
    }
    let params: Record<string, unknown>
    try {
      params = validateParams(method, raw) as Record<string, unknown>
    } catch (error) {
      throw new ChannelError(
        error instanceof Error && error.message === 'unsupported_method'
          ? 'unsupported_method'
          : 'invalid_params'
      )
    }
    if (method.startsWith('delegation.'))
      return this.delegations.request(actor, method, params, operation)
    if (/^(project|workspace|job|review)\./.test(method))
      return this.resources.request(actor, method, params, operation)
    if (!MUTATIONS.has(method as Method)) return this.query(actor, method, params)
    return this.commitOperation(actor, method, params, operation, () =>
      this.mutate(actor, method, params)
    )
  }
  /** Recheck the exact resource of a successful response at the actual transport boundary. */
  checkPublication(actor: AuthorityContext, method: string, raw: unknown) {
    this.authority.check(actor, 'publish')
    if (Object.hasOwn(PairingMethodSchemas, method)) return
    const p = validateParams(method, raw) as Record<string, unknown>
    this.authority.check(
      actor,
      'publish',
      String(p.stream_id ?? p.session_id ?? p.workspace_id ?? p.project_id ?? p.job_id ?? '')
    )
    this.delegations.checkPublication(actor, method, p)
  }
  operationReceipt(
    actor: AuthorityContext,
    method: string,
    params: unknown,
    operation?: string
  ): { result: unknown } | undefined {
    this.authority.check(actor, 'mutate')
    if (!operation || operation.length > 128) throw new ChannelError('operation_id_required')
    const hash = digest(canonical({ method, params }))
    const previous = this.db
      .prepare(
        'SELECT request_hash,receipt FROM operations WHERE principal_id=? AND operation_id=?'
      )
      .get(actor.installation_id, operation) as Row | undefined
    if (!previous) {
      const pending = this.db
        .prepare('SELECT request_hash FROM file_mutations WHERE principal_id=? AND operation_id=?')
        .get(actor.installation_id, operation) as Row | undefined
      if (pending && pending.request_hash !== hash) throw new ChannelError('idempotency_mismatch')
      return
    }
    if (previous.request_hash !== hash) throw new ChannelError('idempotency_mismatch')
    return { result: JSON.parse(String(previous.receipt)) as unknown }
  }
  commitOperation(
    actor: AuthorityContext,
    method: string,
    params: unknown,
    operation: string | undefined,
    work: () => unknown
  ): unknown {
    return this.transaction(() => {
      const previous = this.operationReceipt(actor, method, params, operation)
      if (previous) return previous.result
      const result = work()
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?)')
        .run(
          actor.installation_id,
          operation!,
          digest(canonical({ method, params })),
          JSON.stringify(result)
        )
      return result
    }, true)
  }
  private query(actor: AuthorityContext, method: string, p: Record<string, unknown>): unknown {
    this.authority.check(actor, 'discover', String(p.session_id ?? p.stream_id ?? ''))
    switch (method) {
      case 'node.describe':
        return {
          node_id: this.node_id,
          capabilities: this.capabilities(),
          providers: [
            this.provider.capabilities(),
            this.claude.capabilities(),
            this.claude.capabilities('pi'),
          ],
        }
      case 'session.list':
        return (
          this.db
            .prepare('SELECT body FROM sessions WHERE session_id>? ORDER BY session_id LIMIT ?')
            .all(String(p.after_id ?? ''), Number(p.limit)) as Row[]
        ).map((r) => SessionSchema.parse(JSON.parse(String(r.body))))
      case 'session.get': {
        const row = this.db
          .prepare('SELECT body FROM sessions WHERE session_id=?')
          .get(String(p.session_id)) as Row | undefined
        if (!row) throw new ChannelError('not_found')
        return SessionSchema.parse(JSON.parse(String(row.body)))
      }
      case 'prompt.list': {
        this.head(String(p.session_id))
        const rows = this.db
          .prepare(
            "SELECT body FROM prompts WHERE session_id=? AND prompt_id>? AND (? IS NULL OR json_extract(body,'$.state')=?) ORDER BY prompt_id LIMIT ?"
          )
          .all(
            String(p.session_id),
            String(p.after_id ?? ''),
            p.state ? String(p.state) : null,
            p.state ? String(p.state) : null,
            Number(p.limit)
          ) as Row[]
        const page: Prompt[] = []
        let bytes = 2
        for (const row of rows) {
          const prompt = PromptSchema.parse(JSON.parse(String(row.body)))
          const size = Buffer.byteLength(JSON.stringify(prompt)) + 1
          if (bytes + size > LIMITS.record_bytes - 1024) break
          bytes += size
          page.push(prompt)
        }
        if (rows.length && !page.length) throw new ChannelError('output_limit')
        return page
      }
      case 'stream.read':
        return this.read(String(p.stream_id), Number(p.after_seq), Number(p.limit))
      case 'artifact.read': {
        const row = this.db
          .prepare('SELECT content FROM artifacts WHERE artifact_id=? AND session_id=?')
          .get(String(p.artifact_id), String(p.session_id)) as { content: Uint8Array } | undefined
        if (!row) throw new ChannelError('not_found')
        const offset = Number(p.offset),
          end = Math.min(offset + Number(p.length), row.content.byteLength)
        return {
          offset,
          total: row.content.byteLength,
          base64: Buffer.from(row.content.subarray(offset, end)).toString('base64'),
        }
      }
      default:
        throw new ChannelError('unsupported_method')
    }
  }
  acceptInput(actor: AuthorityContext, p: Record<string, unknown>): unknown {
    return this.mutate(actor, 'session.send', p)
  }
  acceptSession(actor: AuthorityContext, p: Record<string, unknown>, provisioning = false) {
    if (p.provider === 'claude' || p.provider === 'pi') {
      if (!p.workspace_id) throw new ChannelError('workspace_required')
      const workspace = this.resources.workspaces.get(String(p.workspace_id))
      if (this.resources.projects.get(workspace.project_id).trust !== 'trusted')
        throw new ChannelError('project_untrusted')
      if (!this.claude.isAvailable(String(p.provider)))
        throw new ChannelError('provider_unavailable')
    }
    const session = SessionSchema.parse({
      session_id: randomUUID(),
      title: p.title,
      provider: p.provider,
      created_at: new Date().toISOString(),
      ...(p.workspace_id ? { workspace_id: p.workspace_id } : {}),
    })
    this.db.prepare('INSERT INTO streams(stream_id) VALUES(?)').run(session.session_id)
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?)')
      .run(session.session_id, JSON.stringify(session))
    if (p.workspace_id)
      this.resources.workspaces.lease(String(p.workspace_id), session.session_id, provisioning)
    const installationActor = {
      kind: 'installation',
      installation_id: actor.installation_id,
    } as const
    this.append(session.session_id, 'session.created', installationActor, session)
    this.append('catalog', 'session.created', installationActor, session)
    return session
  }
  private mutate(actor: AuthorityContext, method: string, p: Record<string, unknown>): unknown {
    const installationActor = {
      kind: 'installation',
      installation_id: actor.installation_id,
    } as const
    if (method === 'session.create') return this.acceptSession(actor, p)
    const session = String(p.session_id)
    this.head(session)
    if (method === 'session.detach') {
      if (this.delegations.isActive(session)) throw new ChannelError('resource_busy')
      if (
        this.db
          .prepare("SELECT 1 FROM provider_runs WHERE session_id=? AND state='active'")
          .get(session)
      )
        throw new ChannelError('resource_busy')
      if (
        this.db
          .prepare(
            "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
          )
          .get(session)
      )
        throw new ChannelError('resource_busy')
      const row = this.db
        .prepare('SELECT body FROM sessions WHERE session_id=?')
        .get(session) as Row
      const updated = SessionSchema.parse({ ...JSON.parse(String(row.body)), workspace_id: null })
      this.db.prepare('DELETE FROM workspace_leases WHERE session_id=?').run(session)
      this.db
        .prepare('UPDATE sessions SET body=? WHERE session_id=?')
        .run(JSON.stringify(updated), session)
      this.append(session, 'session.updated', installationActor, updated)
      this.append('catalog', 'session.updated', installationActor, updated)
      return updated
    }
    if (method === 'session.send') {
      const current = this.session(session)
      if (current.workspace_id) this.resources.workspaces.assertLease(current.workspace_id, session)
      if (current.provider !== 'fake') {
        if (!current.workspace_id) throw new ChannelError('workspace_required')
        if (!this.claude.isAvailable(current.provider))
          throw new ChannelError('provider_unavailable')
        if (canonical(p.script) !== canonical([{ kind: 'echo' }]))
          throw new ChannelError('invalid_params')
      }
      if (Number(p.observed_seq) > this.head(session)) throw new ChannelError('stale_revision')
      const input_id = randomUUID()
      const event = this.append(session, 'input.accepted', installationActor, {
        input_id,
        text: p.text,
        observed_seq: p.observed_seq,
      })
      this.db
        .prepare(
          'INSERT INTO inputs(input_id,session_id,principal_id,state,body) VALUES(?,?,?,?,?)'
        )
        .run(input_id, session, actor.installation_id, 'accepted', JSON.stringify(p))
      const input = this.db.prepare('SELECT * FROM inputs WHERE input_id=?').get(input_id) as Row
      this.transition(input, 'queued')
      return { input_id, accepted_seq: event.seq }
    }
    if (method === 'prompt.answer') {
      const row = this.db
        .prepare('SELECT body FROM prompts WHERE prompt_id=? AND session_id=?')
        .get(String(p.prompt_id), session) as Row | undefined
      if (!row) throw new ChannelError('not_found')
      const prompt = PromptSchema.parse(JSON.parse(String(row.body)))
      if (
        prompt.run_id !== p.run_id ||
        prompt.revision !== p.revision ||
        prompt.action_digest !== p.action_digest
      )
        throw new ChannelError('stale_revision')
      if (prompt.state === 'expired' || prompt.state === 'invalidated')
        throw new ChannelError('prompt_expired')
      if (prompt.state === 'resolved') return prompt
      if (prompt.expires_at <= Date.now()) throw new ChannelError('prompt_expired')
      if (p.choice === 'allow') {
        if (
          prompt.kind === 'select' &&
          (typeof p.value !== 'string' || !prompt.options?.includes(p.value))
        )
          throw new ChannelError('invalid_params')
        if (prompt.kind === 'input' && typeof p.value !== 'string')
          throw new ChannelError('invalid_params')
        if (prompt.kind !== 'select' && prompt.kind !== 'input' && p.value !== undefined)
          throw new ChannelError('invalid_params')
      }
      return this.resolvePrompt(
        prompt,
        'resolved',
        p.choice as 'allow' | 'deny',
        actor.installation_id,
        p.choice === 'allow' && typeof p.value === 'string' ? p.value : undefined
      )
    }
    if (method === 'input.cancel') {
      const input = this.db
        .prepare('SELECT * FROM inputs WHERE input_id=? AND session_id=?')
        .get(String(p.input_id), session) as Row | undefined
      if (!input) throw new ChannelError('not_found')
      if (!['accepted', 'queued'].includes(String(input.state)))
        throw new ChannelError('resource_busy')
      this.transition(input, 'cancelled')
      return { input_id: p.input_id, state: 'cancelled' }
    }
    if (method === 'session.interrupt') {
      const input = this.db
        .prepare(
          "SELECT * FROM inputs WHERE session_id=? AND run_id=? AND state IN ('dispatching','delivered')"
        )
        .get(session, String(p.run_id)) as Row | undefined
      if (!input) throw new ChannelError('stale_revision')
      this.transition(
        input,
        this.session(session).provider !== 'fake' ? 'delivery_unknown' : 'interrupted'
      )
      this.append(session, 'run.interrupted', installationActor, {
        run_id: p.run_id,
        outcome: 'unknown',
      })
      for (const prompt of this.prompts(session))
        if (prompt.state === 'pending' && prompt.run_id === p.run_id)
          this.resolvePrompt(prompt, 'invalidated', 'deny', null)
      return { run_id: p.run_id, state: 'interrupted' }
    }
    throw new ChannelError('unsupported_method')
  }
  session(id: string) {
    const row = this.db.prepare('SELECT body FROM sessions WHERE session_id=?').get(id) as
      Row | undefined
    if (!row) throw new ChannelError('not_found')
    return SessionSchema.parse(JSON.parse(String(row.body)))
  }
  transition(input: Row, state: string) {
    InputStateSchema.parse(state)
    this.db.prepare('UPDATE inputs SET state=? WHERE input_id=?').run(state, String(input.input_id))
    this.append(String(input.session_id), 'input.' + state, nodeActor, {
      input_id: input.input_id,
      run_id: input.run_id ?? null,
      state,
    })
    input.state = state
  }
  resolvePrompt(
    prompt: Prompt,
    state: Prompt['state'],
    choice: 'allow' | 'deny',
    installation: string | null,
    value?: string
  ): Prompt {
    const result = PromptSchema.parse({
      ...prompt,
      state,
      choice,
      installation_id: installation,
      ...(value !== undefined ? { value } : {}),
    })
    this.db
      .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
      .run(JSON.stringify(result), prompt.prompt_id)
    this.append(
      prompt.session_id,
      'prompt.' + state,
      installation ? { kind: 'installation', installation_id: installation } : nodeActor,
      result
    )
    return result
  }
  workspaceProvisioning(session_id: string) {
    const session = this.session(session_id)
    return (
      !!session.workspace_id &&
      this.resources.workspaces.get(session.workspace_id).state === 'provisioning'
    )
  }
  checkExecution(installation_id: string, session_id: string) {
    const actor = { installation_id }
    this.authority.check(actor, 'execute', session_id)
    const session = this.session(session_id)
    if (session.workspace_id) {
      this.resources.workspaces.assertLease(session.workspace_id, session_id)
      if (this.resources.workspaces.get(session.workspace_id).state !== 'ready')
        throw new ChannelError('resource_busy')
    }
    this.delegations.checkExecution(session_id)
  }
  /** One durable worker per session; at most four sessions execute per tick. No socket participates. */
  tick(now = Date.now()) {
    this.transaction(() => {
      this.delegations.settle()
      for (const row of this.db
        .prepare("SELECT body FROM prompts WHERE json_extract(body,'$.state')='pending'")
        .all() as Row[]) {
        const prompt = PromptSchema.parse(JSON.parse(String(row.body)))
        if (prompt.expires_at <= now) this.resolvePrompt(prompt, 'expired', 'deny', null)
      }
      const sessions = this.db
        .prepare(
          "SELECT session_id, MIN(ordinal) AS first FROM inputs WHERE state IN ('accepted','queued','dispatching','delivered') GROUP BY session_id ORDER BY first LIMIT 4"
        )
        .all() as Row[]
      for (const s of sessions) {
        const input = this.db
          .prepare(
            "SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered') ORDER BY ordinal LIMIT 1"
          )
          .get(String(s.session_id)) as Row
        InputStateSchema.parse(input.state)
        if (
          this.session(String(input.session_id)).provider !== 'fake' ||
          this.workspaceProvisioning(String(input.session_id))
        )
          continue
        const body = validateParams('session.send', JSON.parse(String(input.body))) as {
          text: string
          script: FakeStep[]
        }
        if (input.state === 'queued' || input.state === 'accepted') {
          try {
            this.checkExecution(String(input.principal_id), String(input.session_id))
          } catch {
            this.transition(input, 'cancelled')
            continue
          }
          input.run_id = randomUUID()
          this.db
            .prepare('UPDATE inputs SET run_id=? WHERE input_id=?')
            .run(String(input.run_id), String(input.input_id))
          this.transition(input, 'dispatching')
          this.append(String(input.session_id), 'run.started', nodeActor, {
            run_id: input.run_id,
            input_id: input.input_id,
          })
          // FakeProvider evidence is deterministic and has no external side effects.
          this.transition(input, 'delivered')
        }
        const actor = {
          kind: 'provider',
          provider: 'fake',
          session_id: String(input.session_id),
        } as const
        const script = this.provider.validate(body.script)
        let blocked = false,
          failed = false
        for (let step = Number(input.step); step < script.length; step++) {
          const action = script[step]!
          if (action.kind === 'hang') {
            blocked = true
            break
          }
          if (action.kind === 'fail') {
            failed = true
            break
          }
          if (action.kind === 'permission') {
            const action_digest = digest(canonical({ run: input.run_id, step, action }))
            let prompt = this.prompts(String(input.session_id)).find(
              (p) => p.run_id === input.run_id && p.action_digest === action_digest
            )
            if (!prompt) {
              prompt = PromptSchema.parse({
                prompt_id: randomUUID(),
                session_id: input.session_id,
                run_id: input.run_id,
                revision: 1,
                action_digest,
                expires_at: now + action.ttl_ms,
                state: 'pending',
                choice: null,
                installation_id: null,
                delivered: false,
              })
              this.db
                .prepare('INSERT INTO prompts VALUES(?,?,?,?)')
                .run(prompt.prompt_id, prompt.session_id, prompt.run_id, JSON.stringify(prompt))
              this.append(prompt.session_id, 'prompt.opened', actor, prompt)
            }
            if (prompt.state === 'pending') {
              blocked = true
              break
            }
            prompt.delivered = true
            this.db
              .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
              .run(JSON.stringify(prompt), prompt.prompt_id)
            this.append(prompt.session_id, 'prompt.delivered', nodeActor, {
              prompt_id: prompt.prompt_id,
              run_id: prompt.run_id,
              choice: prompt.choice,
            })
            if (prompt.choice !== 'allow') {
              failed = true
              break
            }
          } else {
            const text = action.kind === 'echo' ? body.text : action.text
            if (Buffer.byteLength(text) > 8192) {
              const artifact_id = randomUUID()
              this.db
                .prepare('INSERT INTO artifacts VALUES(?,?,?)')
                .run(artifact_id, String(input.session_id), Buffer.from(text))
              this.append(String(input.session_id), 'content.delta', actor, {
                run_id: input.run_id,
                artifact_id,
                size: Buffer.byteLength(text),
              })
            } else
              this.append(String(input.session_id), 'content.delta', actor, {
                run_id: input.run_id,
                text,
              })
          }
          this.db
            .prepare('UPDATE inputs SET step=? WHERE input_id=?')
            .run(step + 1, String(input.input_id))
        }
        if (!blocked) {
          this.transition(input, failed ? 'failed' : 'completed')
          this.append(String(input.session_id), failed ? 'run.failed' : 'run.completed', actor, {
            run_id: input.run_id,
          })
        }
      }
      this.delegations.settle()
    })
  }
}
