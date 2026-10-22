import { DatabaseSync } from 'node:sqlite'
import { ChatCheckpoints } from './chat-checkpoints.js'
import { ObsidianTools } from './obsidian-tools.js'
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
  SessionCommandsSchema,
  SESSION_UPDATE_VERSION,
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
  type ExpectedExecutionTarget,
  type TurnAdmissionResult,
  type SessionSettings,
} from '@abele/node-protocol'

import { DebuggerService, migrateDebugger } from './debugger/index.js'
import { DebuggerCoordinator } from './debugger/coordinator.js'
import { DebuggerLaunches, type LaunchProfile } from './debugger/launch.js'
import { JsDebugProfile as NativeJsProfile } from './debugger/js-profile.js'
import { TraceService } from './trace/service.js'
import { HttpService } from './http/service.js'
import { migrateDebuggerControl, migrateDebuggerModes } from './debugger/storage.js'
export { DebuggerCoordinator } from './debugger/coordinator.js'
export { DebuggerAgentBinding, debuggerToolDefinitions } from './debugger/agent.js'
export { DebuggerRunBinding } from './debugger/run.js'
export type { DebuggerRunContext } from './debugger/run.js'
export { DapDebuggerBackend } from './debugger/dap-backend.js'
export { TraceService } from './trace/service.js'
export { HttpService } from './http/service.js'
export { HttpStore } from './http/store.js'
export { TraceStore } from './trace/store.js'
export { TracePoints, TraceRecorder } from './trace/recorder.js'
export type {
  DebuggerPrincipal,
  DebuggerBackend,
  DebuggerDispatchGuard,
} from './debugger/coordinator.js'
export { DebuggerService, DebuggerStateError, reduceDebugger } from './debugger/index.js'
export type { DebuggerObservation, DebuggerAdapterSink } from './debugger/index.js'
export { installJsAdapter, JS_DEBUG_AUDIT, JS_DEBUG_PIN } from './debugger/js-install.js'
export { JsDebugProfile } from './debugger/js-profile.js'
export { DebuggerLaunches, type LaunchProfile, type LaunchedRun } from './debugger/launch.js'
export type { JsLaunch, JsAttach } from './debugger/js-profile.js'
import { canonicalStateDir } from './state.js'
export { canonicalStateDir } from './state.js'
export { LiveSessions, DEFAULT_CONTINUATION, type LiveOptions } from './live-sessions.js'
export { acquireUpdateLock } from './update-lock.js'
import { ResourceServices } from './resources.js'
import type { GitRunner } from './git.js'
import { ManagerService } from './manager.js'
import type { ResolvedExecutionTarget } from './execution-targets.js'
import { DelegationService } from './delegation.js'
export { DelegationService, DelegationMailbox, WorkerReporter } from './delegation.js'
import { PairingService } from './pairing.js'
export { PairingService, IdentityStore } from './pairing.js'
import { ProviderSessions } from './claude.js'
import type { LiveOptions } from './live-sessions.js'
import type { ProviderAdapter } from './providers.js'
export type { ProviderAdapter } from './providers.js'
export { CodexProviderAdapter } from '@abele/provider-codex'
export { PiProviderAdapter } from '@abele/provider-pi'
export { ClaudeProviderAdapter } from '@abele/provider-claude'
export { AcpProviderAdapter } from '@abele/provider-acp'
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

import { nodeReleaseVersion } from './release.js'
const NODE_RELEASE_VERSION = nodeReleaseVersion()

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
  private readonly invalidationListeners = new Set<() => void>()
  subscribeInvalidation(listener: () => void) {
    this.invalidationListeners.add(listener)
    return () => {
      this.invalidationListeners.delete(listener)
    }
  }
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
  /** Inside device revocation: a later claim of the same key cannot revive
   * grants OR exact approvals that the revoked registration authored. */
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
    this.db
      .prepare(
        `UPDATE debug_grants SET body=json_set(body,'$.revoked',json('true'))
      WHERE (json_extract(body,'$.owner_authority.profile')='paired-wss-v1' AND (? IS NULL OR json_extract(body,'$.owner_authority.installation_id')=?))
         OR (json_extract(body,'$.controller_authority.profile')='paired-wss-v1' AND (? IS NULL OR json_extract(body,'$.controller_authority.installation_id')=?))`
      )
      .run(
        installation_id ?? null,
        installation_id ?? null,
        installation_id ?? null,
        installation_id ?? null
      )
    this.db
      .prepare(
        `UPDATE debug_operations SET body=json_set(body,'$.approval_revoked',json('true'))
        WHERE json_extract(body,'$.receipt.outcome')='pending'
          AND json_extract(body,'$.approval_authority.profile')='paired-wss-v1'
          AND (? IS NULL OR json_extract(body,'$.approval_authority.installation_id')=?)`
      )
      .run(installation_id ?? null, installation_id ?? null)
    // Revocation may be inside an outer transaction. Publish only after that
    // synchronous commit boundary, never from an intermediate authority row.
    queueMicrotask(() => {
      for (const listener of this.invalidationListeners) listener()
    })
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
  readonly obsidianTools: ObsidianTools
  private checkpoints?: ChatCheckpoints
  get chatCheckpoints() {
    return (this.checkpoints ??= new ChatCheckpoints(this))
  }
  readonly db: DatabaseSync
  readonly stateDir: string
  readonly authority: AuthorityService
  readonly pairing: PairingService
  readonly debugger: DebuggerService
  readonly debuggerControl: DebuggerCoordinator
  /** Programs the owner started under the debugger. */
  readonly debuggerLaunches: DebuggerLaunches
  readonly trace: TraceService
  /** The project's saved requests and sending them. */
  readonly http: HttpService
  readonly manager: ManagerService
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
    options: {
      worktreeRoot?: string
      /** Optional Git executor; omitted uses the product's bounded defaults. */
      git?: GitRunner
      /** Authorized control infrastructure, off by default. Native profiles
       * require a separate explicit switch and an audited adapter installation. */
      debuggerEnabled?: boolean
      /** Trusted seam for tests: what starts a program under the debugger. The native JS profile,
       * still refusing until an audited adapter is installed, otherwise. */
      debuggerProfile?: (core: NodeCore) => LaunchProfile
      claude?: ProviderAdapter
      pi?: ProviderAdapter
      codex?: ProviderAdapter
      /** Agents that speak ACP. */
      acp?: ProviderAdapter
      /** Policy for long-lived owner sessions. */
      live?: LiveOptions
    } = {}
  ) {
    stateDir = this.stateDir = canonicalStateDir(stateDir)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    chmodSync(stateDir, 0o700)
    this.db = new DatabaseSync(join(stateDir, 'node.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;'
    )
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    if (version > 19) {
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
    if (version < 12)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE codex_thread_bindings(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), thread_id TEXT NOT NULL UNIQUE, workspace_path TEXT NOT NULL, policy_fingerprint TEXT NOT NULL, model TEXT NOT NULL);
      PRAGMA user_version=12; COMMIT;`)
    if (version < 13) migrateDebugger(this.db)
    if (version < 14) migrateDebuggerControl(this.db)
    if (version < 15) migrateDebuggerModes(this.db)
    if (version < 16)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS deleted_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id));
      PRAGMA user_version=16; COMMIT;`)
    if (version < 17)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS claude_native_accounts(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), account TEXT NOT NULL);
      PRAGMA user_version=17; COMMIT;`)
    if (version < 18) {
      // What another node needs to take over a long-lived process this one left running.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(provider_runs)').all() as Row[]).map((c) => c.name)
      )
      this.db.exec(`BEGIN IMMEDIATE;
      ${columns.has('live') ? '' : 'ALTER TABLE provider_runs ADD COLUMN live TEXT;'}
      ${columns.has('live_state') ? '' : 'ALTER TABLE provider_runs ADD COLUMN live_state TEXT;'}
      ${columns.has('stream_offset') ? '' : 'ALTER TABLE provider_runs ADD COLUMN stream_offset INTEGER NOT NULL DEFAULT 0;'}
      PRAGMA user_version=18; COMMIT;`)
    }
    if (version < 19)
      this.db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE workspace_leases RENAME TO workspace_leases_single;
      CREATE TABLE workspace_leases(workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), session_id TEXT PRIMARY KEY REFERENCES sessions(session_id));
      INSERT INTO workspace_leases SELECT * FROM workspace_leases_single;
      DROP TABLE workspace_leases_single;
      CREATE INDEX workspace_leases_workspace ON workspace_leases(workspace_id);
      PRAGMA user_version=19; COMMIT;`)
    // Additive execution intent store, like the auxiliary replay/checkpoint tables below.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS session_owner_stops(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), generation INTEGER NOT NULL CHECK(generation>0), stopped INTEGER NOT NULL CHECK(stopped IN (0,1)))'
    )
    // The agent's latest "/" list per session, so a client opening at the tail need not scan back.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS session_commands(session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, body TEXT NOT NULL)'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS chat_restore_attempts(principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id))'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS chat_checkpoints(checkpoint_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL)'
    )
    const identity = this.db.prepare("SELECT value FROM meta WHERE key='node_id'").get() as
      Row | undefined
    this.node_id = identity ? String(identity.value) : randomUUID()
    if (!identity) this.db.prepare("INSERT INTO meta VALUES('node_id',?)").run(this.node_id)
    this.authority = new AuthorityService(this.db)
    this.pairing = new PairingService(this)
    this.delegations = new DelegationService(this)
    try {
      this.debugger = new DebuggerService(this, options.debuggerEnabled)
      this.debuggerControl = new DebuggerCoordinator(this)
      this.trace = new TraceService(this)
      this.http = new HttpService(this)
      this.authority.subscribeInvalidation(() => {
        if (!this.closed) this.debuggerControl.notifyPermissions()
      })
      this.resources = new ResourceServices(this, options.worktreeRoot, options.git)
      this.manager = new ManagerService(this)
      this.obsidianTools = new ObsidianTools(this)
      this.resources.mutations.recover()
      this.debuggerLaunches = new DebuggerLaunches(
        this,
        options.debuggerProfile?.(this) ??
          new NativeJsProfile(this.debugger, {
            stateDirectory: stateDir,
            enabled: !!options.debuggerEnabled,
          })
      )
    } catch (error) {
      this.db.close()
      throw error
    }
    this.transaction(() => {
      this.delegations.repairLeases()
      // A long-lived process the last node left running keeps its inputs; adoption decides.
      const active = this.db
        .prepare(
          "SELECT * FROM inputs WHERE state IN ('dispatching','delivered') AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM provider_runs WHERE state='active' AND live IS NOT NULL))"
        )
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
        if (prompt.run_id.startsWith('obsidian:')) continue
        this.resolvePrompt(prompt, 'invalidated', 'deny', null)
      }
    })
    this.execution = new ProviderSessions(
      this,
      new Map(
        Object.entries({
          claude: options.claude,
          pi: options.pi,
          codex: options.codex,
          acp: options.acp,
        }).filter((entry): entry is [string, ProviderAdapter] => entry[1] !== undefined)
      ),
      options.live
    )
    this.claude = this.execution
    // Legacy sessions remain Ask instead of adopting a new bypass default.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT session_id,body FROM sessions').all()) {
        const session = SessionSchema.parse(JSON.parse(String(row.body)))
        const permission_mode =
          session.settings?.permission_mode ?? session.tool_permissions?.permission_mode ?? 'manual'
        const tool_permissions = this.claude.permissionPolicy(session.provider, {
          ...session.settings,
          permission_mode,
        })
        this.db
          .prepare('UPDATE sessions SET body=? WHERE session_id=?')
          .run(JSON.stringify({ ...session, tool_permissions }), String(row.session_id))
        this.delegations.permissionsChanged(String(row.session_id), tool_permissions)
      }
    })
    this.protectFiles()
  }
  private watchers = new Map<string, number>()
  private unwatched = new Map<string, number>()
  /** A client follows this stream live. Long-lived sessions stay up while someone watches. */
  watch(stream: string) {
    this.watchers.set(stream, (this.watchers.get(stream) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.watchers.get(stream) ?? 1) - 1
      if (left > 0) this.watchers.set(stream, left)
      else {
        this.watchers.delete(stream)
        this.unwatched.set(stream, Date.now())
      }
    }
  }
  watching(stream: string) {
    return this.watchers.get(stream) ?? 0
  }
  unwatchedAt(stream: string) {
    return this.unwatched.get(stream) ?? 0
  }
  protectFiles() {
    for (const file of readdirSync(this.stateDir))
      if (file.startsWith('node.sqlite')) chmodSync(join(this.stateDir, file), 0o600)
  }
  close() {
    if (!this.closed) {
      this.obsidianTools.close()
      void this.resources?.lsp.stop()
      this.trace.close()
      this.http.close()
      this.manager.close()
      void this.debuggerLaunches
        ?.close()
        .catch((error) => console.debug('[debugger] Closing started programs failed', error))
      this.debuggerControl.close()
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
    this.transaction(() => {
      this.db.prepare('UPDATE installations SET revoked=1 WHERE installation_id=?').run(id)
      this.db.prepare("UPDATE paired_devices SET state='revoked' WHERE installation_id=?").run(id)
      this.authority.invalidatePairedGrants(id)
    })
    this.debuggerControl.notifyPermissions()
    this.resources.repository.revoked(id)
    this.manager.notifyPermissions()
  }
  /** Fence external effects after any audit transaction failure, across sessions. */
  assertAuditStorageAvailable() {
    if (this.storageFailed) throw new ChannelError('storage_unavailable')
  }
  /** Synchronous state/receipt/event commit only; Git effects must stay outside. */
  transaction<T>(work: () => T, inject = false): T {
    this.assertAuditStorageAvailable()
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
    // The node's own inputs (a continuation after compaction) stay derived on replay, like its
    // other events: the journal's session updates come from people and providers only.
    const input =
      type === 'input.accepted' && actor.kind !== 'node'
        ? (data as { input_id?: string; text?: string })
        : undefined
    const userUpdate =
      input && typeof input.input_id === 'string' && typeof input.text === 'string'
        ? {
            kind: 'user_message',
            message_id: input.input_id,
            text: input.text.slice(0, 65536),
            ...(input.text.length > 65536 ? { truncated: true } : {}),
          }
        : undefined
    if (userUpdate) data = { ...input, mapped: true }
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
    if (type === 'session.update') {
      const update = (event.data as { update: { kind: string; commands?: unknown } }).update
      if (update.kind === 'available_commands_update')
        this.db
          .prepare(
            'INSERT INTO session_commands VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq, body=excluded.body'
          )
          .run(stream, event.seq, JSON.stringify(update.commands))
    }
    this.resources?.lsp.observe(stream, type, data)
    if (type === 'run.started') this.delegations?.runStarted(stream)
    if (type === 'prompt.opened') this.delegations?.promptOpened(stream, data as Prompt)
    if (userUpdate) this.append(stream, 'session.update', actor, { update: userUpdate })
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
  discovery() {
    return {
      node_version: NODE_RELEASE_VERSION,
      supported_capabilities: Object.entries(this.capabilities().capabilities)
        .filter(([, capability]) => capability.status === 'supported')
        .map(([name]) => name),
    }
  }
  capabilities() {
    const claude = this.claude.capabilities()
    return {
      ...this.provider.capabilities(),
      provider: 'node',
      provider_version: '5',
      providers: [
        this.provider.capabilities(),
        claude,
        this.claude.capabilities('pi'),
        this.claude.capabilities('acp'),
        this.claude.capabilities('codex'),
      ],
      capabilities: {
        'execution.policy.v1': {
          status: 'supported' as const,
          evidence:
            'Call execution.policy.v1.enable with {} on each channel connection to receive extended project/session/delegation policy fields.',
        },
        'tool.permissions.v1': {
          status: 'supported' as const,
          evidence: 'persisted-session-delegation-mode-and-per-action-approval',
        },
        'session.owner-stop.v1': {
          status: 'supported' as const,
          evidence:
            'session.owner-stop.v1.enable; durable-session-fence; generation-matched-session.owner_restart; owner-UI-only',
        },
        'codex.developer-environment.v1': {
          status: 'supported' as const,
          evidence: 'node-npm-worktree-git-external-caches-project-network-opt-in',
        },
        'obsidian.tools.v1': {
          status: 'supported' as const,
          evidence: 'durable-invocation-single-executor-claim-v1',
        },
        'obsidian.tools.questions.v1': {
          status: 'supported' as const,
          evidence: 'invocation-bound-durable-questionnaire-v1',
        },
        'obsidian.tools.delegate-host.v1': {
          status: 'supported' as const,
          evidence: 'root-budget-depth-branch-claim-and-history-v1',
        },
        device_disconnect: {
          status: 'supported' as const,
          evidence: 'authenticated-self-revocation',
        },
        pi_dependency_diagnostics: {
          status: 'supported' as const,
          evidence: 'explicit-startup-dependency-warning-once-per-session',
        },
        ...this.provider.capabilities().capabilities,
        ...this.debugger.capabilities(),
        ...(this.debugger.enabled
          ? {
              'debugger.access.v1': {
                status: 'supported' as const,
                evidence: 'debugger-access-request-v1; owner-decide; issuer-list-revoke-delete',
              },
            }
          : {}),
        ...this.trace.capabilities(),
        ...this.http.capabilities(),
        command_run_v1: {
          status: 'supported',
          evidence:
            'command.v1.run/status/cancel; exact-durable-owner-prompt; trusted-target; bounded-streaming-output',
        },
        git_integrate_v1: {
          status: 'supported',
          evidence:
            'git.v1.integrate; exact-durable-owner-prompt; expected-heads; ff-only; optional-conflict-aborting-rebase',
        },
        expected_target: {
          status: 'supported',
          evidence: 'atomic-target-admission: session.send; delegation.send; review.submit',
        },
        delegation_without_grant: {
          status: 'supported',
          evidence: 'installation-authority; parent_id-required; retained-controller-binding',
        },
        'session.rename': {
          status: 'supported',
          evidence: 'journaled-display-title; operation-receipts',
        },
        'session.delete': {
          status: 'supported',
          evidence: 'idle-only-catalog-removal; retained-journal; operation-receipts',
        },
        lsp_v1: {
          status: 'supported',
          evidence: 'lsp.v1; confined-stdio; definition; merged-diagnostics; private-installs',
        },
        session_updates: {
          status: 'supported',
          evidence: `session-update-v${SESSION_UPDATE_VERSION}; session.commands`,
        },
        session_letters_v1: {
          status: 'supported',
          evidence: 'session.send sender; isolated letter turns; input.reply',
        },
        long_lived_sessions: this.claude.adapterFor('claude')?.liveAvailable
          ? {
              status: 'supported',
              evidence:
                'session.configure; session.compact; session.stop; session.state; turn.*; session.process',
            }
          : { status: 'unsupported', reason: 'Claude CLI without streamed input, or turned off' },
        session_survives_restart: this.claude.adapterFor('claude')?.liveAvailable
          ? {
              status: 'supported',
              evidence: 'detached session host; adoption on start; session.process reattached',
            }
          : { status: 'unsupported', reason: 'Claude CLI without streamed input, or turned off' },
        session_messages: this.claude.adapterFor('claude')?.liveAvailable
          ? {
              status: 'supported',
              evidence:
                'agent tools node_sessions, node_session_send; input.accepted from_session; session.message.sent; settings.messaging',
            }
          : { status: 'unsupported', reason: 'Claude CLI without streamed input, or turned off' },
        repository_changes_v1: {
          status: 'supported',
          evidence:
            'repository.v1.watch changes cursor; repository.changed numbered tree and git batches; explicit incomplete',
        },
        workspace_changes_v1: {
          status: 'supported',
          evidence:
            'workspace.watch changes cursor; workspace.files_changed numbered plain folder batches; explicit incomplete',
        },
        node_path_v2: {
          empty_directories: true,
          status: 'supported',
          evidence:
            'exact-folders; owner-picker; durable-init; observed-status; divergence; watch-selection',
        },
        node_path_worktrees: {
          status: 'supported',
          evidence: 'named-branch-create; owner-selection; preconditioned-nonforce-external-delete',
        },
        node_path_file_operations: {
          status: 'supported',
          evidence:
            'regular-files-and-confirmed-bounded-directory-trees; plain-root-workspaces-only; git-targets-repository-only; recovery; unknown-outcomes',
        },
        node_path_execution: {
          status: 'supported',
          evidence:
            'identity-bound-owner-grants; root-plain-external-cwd; exclusive-execution-time-leases',
        },
        node_path_switching: {
          status: 'supported',
          evidence:
            'expected-target-owner-switch; run-bound-pending-switch; confirmed-cleanup-boundary; unbound-native-sessions-only',
        },
        node_path_native_switching: {
          status: 'unsupported',
          reason: 'Provider-native continuation across targets requires explicit rebinding',
        },
        repository_read_v1: {
          status: 'supported',
          evidence: 'repository.v1; opaque-worktrees; frozen-objects; bounded-worker-search',
        },
        repository_editing_v1: {
          status: 'supported',
          evidence: 'durable-file-mutations; identity-bound-external-owner-approval',
        },
        repository_git_write_v1: {
          status: 'supported',
          evidence:
            'repository.v1.git stage/unstage/discard/commit/update(rebase)/continue/abort/push(force-with-lease)/fetch/create_branch/info; editing-permission; durable-receipts; unknown-outcomes',
        },
        repository_notifications_v1: {
          status: 'supported',
          evidence: 'leased-watchers-and-reconciliation-v1',
        },
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
  request(
    actor: AuthorityContext,
    method: string,
    raw: unknown,
    operation?: string,
    signal?: AbortSignal
  ): unknown {
    this.authority.check(actor, 'request')
    if (method.startsWith('obsidian.tools.v1.'))
      return this.obsidianTools.request(actor, method, raw, signal)
    if (method.startsWith('chat.'))
      return this.chatCheckpoints.request(actor, method, raw, operation)
    if (method.startsWith('lsp.v1.')) return this.resources.lsp.request(actor, method, raw, signal)
    if (method.startsWith('debugger.v1.'))
      return this.debuggerControl.request(actor, method, raw, operation, signal)
    if (method.startsWith('trace.v1.')) return this.trace.request(actor, method, raw)
    if (method.startsWith('http.v1.')) return this.http.request(actor, method, raw)
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
    if (
      [
        'project.trust',
        'project.execution',
        'session.worktree.get',
        'session.worktree.set',
      ].includes(method) ||
      (method === 'session.create' && params.target)
    )
      return this.resources.targets.request(actor, method, params, operation)
    if (method.startsWith('delegation.'))
      return this.delegations.request(actor, method, params, operation)
    if (method.startsWith('command.v1.') || method === 'git.v1.integrate')
      return this.manager.request(actor, method, params, operation)
    if (/^(project|workspace|job|review|repository|filesystem)\./.test(method))
      return this.resources.request(actor, method, params, operation)
    if (!MUTATIONS.has(method as Method)) return this.query(actor, method, params)
    const result = this.commitOperation(actor, method, params, operation, () =>
      this.mutate(actor, method, params, method === 'session.send' || method === 'session.compact')
    )
    if (method === 'prompt.answer') this.manager.answered(result as Prompt, actor)
    if (method === 'session.interrupt') this.debuggerControl.interruptedRun(String(params.run_id))
    return result
  }
  /** Invalidations are hints, not evidence that obsolete external authority can be replayed. */
  canPublishEvent(actor: AuthorityContext, event: JournalEvent) {
    this.authority.check(actor, 'publish', event.stream_id)
    return (
      !['repository.invalidated', 'repository.changed'].includes(event.type) ||
      this.resources.repository.canPublishInvalidation(event.data)
    )
  }
  /** Recheck the exact resource of a successful response at the actual transport boundary. */
  checkPublication(actor: AuthorityContext, method: string, raw: unknown, result?: unknown) {
    // The sole response allowed after self-revocation contains no protected data.
    if (
      method === 'node.disconnect' &&
      (result as { disconnected?: unknown } | undefined)?.disconnected === true
    )
      return
    this.authority.check(actor, 'publish')
    if (method.startsWith('debugger.v1.'))
      return this.debuggerControl.checkRpcPublication(actor, method, raw, result)
    // Owner-only views of the owner's own runs folder: nothing scoped beyond the installation.
    if (method.startsWith('trace.v1.')) return
    // Owner-only, the owner's own project files and sends.
    if (method.startsWith('http.v1.')) return
    if (Object.hasOwn(PairingMethodSchemas, method)) return
    const p = validateParams(method, raw) as Record<string, unknown>
    if (method.startsWith('command.v1.') || method === 'git.v1.integrate')
      return this.manager.checkPublication(actor, p)
    this.authority.check(
      actor,
      'publish',
      String(
        p.stream_id ??
          p.session_id ??
          p.workspace_id ??
          p.worktree_id ??
          p.project_id ??
          p.job_id ??
          ''
      )
    )
    this.delegations.checkPublication(actor, method, p)
    if (method === 'repository.v1.worktree.delete')
      return this.resources.repository.checkDeletionPublication(actor, p)
    if (method.startsWith('repository.v1.')) {
      this.resources.repository.checkPublication(actor, p, result)
      this.resources.repository.mutationPublication(actor, method, p)
    }
  }
  operationReceipt(
    actor: AuthorityContext,
    method: string,
    params: unknown,
    operation?: string
  ): { result: unknown } | undefined {
    this.authority.check(actor, 'mutate')
    if (!operation || operation.length > 128) throw new ChannelError('operation_id_required')
    return this.storedOperationReceipt(
      actor.installation_id,
      operation,
      digest(canonical({ method, params }))
    )
  }
  private pendingOperations(principal: string, operation: string): Row[] {
    return this.db
      .prepare(
        `SELECT request_hash FROM file_mutations WHERE principal_id=?1 AND operation_id=?2
      UNION ALL SELECT request_hash FROM node_path_effects WHERE principal_id=?1 AND operation_id=?2
      UNION ALL SELECT request_hash FROM repository_deletions WHERE principal_id=?1 AND operation_id=?2
      UNION ALL SELECT request_hash FROM repository_git_effects WHERE principal_id=?1 AND operation_id=?2
      UNION ALL SELECT request_hash FROM chat_restore_attempts WHERE principal_id=?1 AND operation_id=?2`
      )
      .all(principal, operation) as Row[]
  }
  /** Trusted receipt/recovery boundary; callers keep the identity check and insertion in one transaction. */
  storedOperationReceipt(
    principal: string,
    operation: string,
    requestHash: string
  ): { result: unknown } | undefined {
    const previous = this.db
      .prepare(
        'SELECT request_hash,receipt FROM operations WHERE principal_id=? AND operation_id=?'
      )
      .get(principal, operation) as Row | undefined
    if (
      (previous && previous.request_hash !== requestHash) ||
      this.pendingOperations(principal, operation).some((row) => row.request_hash !== requestHash)
    )
      throw new ChannelError('idempotency_mismatch')
    return previous ? { result: JSON.parse(String(previous.receipt)) as unknown } : undefined
  }
  /** Atomically claim the global operation namespace with the durable effect intent. No effects inside SQL. */
  reserveOperation(
    actor: AuthorityContext,
    method: string,
    params: unknown,
    operation: string,
    insertIntent: () => void
  ) {
    return this.transaction(() => {
      const previous = this.operationReceipt(actor, method, params, operation)
      if (previous) return previous
      if (this.pendingOperations(actor.installation_id, operation).length)
        throw new ChannelError('outcome_unknown')
      insertIntent()
      return undefined
    })
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
  /** Called inside the owning mutation transaction, including delegation deletion. */
  deleteSession(actor: AuthorityContext, session: string) {
    this.authority.check(actor, 'request', session)
    this.session(session)
    const installationActor = {
      kind: 'installation',
      installation_id: actor.installation_id,
    } as const
    // Preserve audit streams, provider-native history and receipts. Only remove
    // the catalog entry and its idle bindings; never stop a turn as a side effect.
    if (this.delegations.isActive(session)) throw new ChannelError('resource_busy')
    this.obsidianTools.cancelRunInTransaction(session, actor.installation_id)
    this.resources.targets.detach(session)
    this.db.prepare('DELETE FROM workspace_leases WHERE session_id=?').run(session)
    const deleted = { session_id: session, deleted: true }
    this.append(session, 'session.deleted', installationActor, deleted)
    this.append('catalog', 'session.deleted', installationActor, deleted)
    // Tombstone keeps historical foreign keys (inputs, artifacts, native bindings)
    // valid without making the chat available for new work.
    this.db.prepare('INSERT INTO deleted_sessions VALUES(?)').run(session)
    return deleted
  }
  private query(actor: AuthorityContext, method: string, p: Record<string, unknown>): unknown {
    this.authority.check(actor, 'discover', String(p.session_id ?? p.stream_id ?? ''))
    switch (method) {
      case 'node.disconnect':
        this.revokeToken(actor.installation_id)
        return { disconnected: true }
      case 'node.describe':
        return {
          node_id: this.node_id,
          ...this.discovery(),
          capabilities: this.capabilities(),
          providers: [
            this.provider.capabilities(),
            this.claude.capabilities(),
            this.claude.capabilities('pi'),
            this.claude.capabilities('acp'),
            this.claude.capabilities('codex'),
          ],
        }
      case 'session.list':
        return (
          this.db
            .prepare(
              'SELECT body FROM sessions WHERE session_id>? AND session_id NOT IN (SELECT session_id FROM deleted_sessions) ORDER BY session_id LIMIT ?'
            )
            .all(String(p.after_id ?? ''), Number(p.limit)) as Row[]
        ).map((r) => this.session(String(JSON.parse(String(r.body)).session_id)))
      case 'session.get':
        return this.session(String(p.session_id))
      case 'session.commands': {
        const session_id = this.session(String(p.session_id)).session_id
        const row = this.db
          .prepare('SELECT seq, body FROM session_commands WHERE session_id=?')
          .get(session_id) as Row | undefined
        return SessionCommandsSchema.parse({
          session_id,
          commands: row ? JSON.parse(String(row.body)) : [],
          seq: row ? Number(row.seq) : 0,
        })
      }
      case 'session.state':
        return this.claude.live.state(this.session(String(p.session_id)).session_id)
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
      case 'stream.head':
        return { head_seq: this.head(String(p.stream_id)) }
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
  acceptInput(actor: AuthorityContext, p: Record<string, unknown>): TurnAdmissionResult {
    return this.mutate(actor, 'session.send', p) as TurnAdmissionResult
  }
  /** Trusted owner request services only, inside their validated operation transaction.
   * Model/controller adapters must use acceptInput, regardless of installation identity. */
  acceptOwnerInput(actor: AuthorityContext, p: Record<string, unknown>): TurnAdmissionResult {
    this.authority.check(actor, 'execute', String(p.session_id))
    return this.mutate(actor, 'session.send', p, true) as TurnAdmissionResult
  }
  acceptSession(
    actor: AuthorityContext,
    p: Record<string, unknown>,
    provisioning = false,
    executionTarget?: ResolvedExecutionTarget
  ) {
    if (p.provider !== 'fake') {
      if (!executionTarget) {
        if (!p.workspace_id) throw new ChannelError('workspace_required')
        const workspace = this.resources.workspaces.get(String(p.workspace_id))
        if (this.resources.projects.get(workspace.project_id).trust !== 'trusted')
          throw new ChannelError('project_untrusted')
      } else this.resources.targets.check(executionTarget)
      if (!this.claude.isAvailable(String(p.provider)))
        throw new ChannelError('provider_unavailable')
      const hosts = this.claude.adapterFor(String(p.provider))?.agentAvailable
      if (hosts && !this.claude.adapterFor(String(p.provider))!.agentAvailable!(String(p.agent)))
        throw new ChannelError('provider_unavailable')
    }
    const liveAdapter = this.claude.adapterFor(String(p.provider))
    if (p.settings)
      try {
        if (
          !liveAdapter?.liveAvailable &&
          Object.keys(p.settings).some((key) => key !== 'permission_mode')
        )
          throw new Error('bounded_settings_unsupported')
        liveAdapter?.validateSettings?.(p.settings as SessionSettings)
        const mode = (p.settings as SessionSettings).permission_mode
        if (
          mode === 'bypassPermissions' &&
          !liveAdapter?.configuration.permission_modes?.includes(mode)
        )
          throw new Error('bypass_unavailable')
      } catch {
        throw new ChannelError('invalid_params')
      }
    const session = SessionSchema.parse({
      session_id: randomUUID(),
      title: p.title,
      provider: p.provider,
      created_at: new Date().toISOString(),
      ...(p.workspace_id ? { workspace_id: p.workspace_id } : {}),
      ...(p.settings ? { settings: p.settings } : {}),
      tool_permissions: this.claude.permissionPolicy(
        String(p.provider),
        p.settings as SessionSettings | undefined
      ),
      ...(p.agent ? { agent: p.agent } : {}),
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
  private mutate(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    ownerInput = false
  ): unknown {
    const installationActor = {
      kind: 'installation',
      installation_id: actor.installation_id,
    } as const
    if (method === 'session.create') return this.acceptSession(actor, p)
    const session = String(p.session_id)
    this.head(session)
    const currentSession = this.session(session)
    if (method === 'session.rename') {
      const updated = SessionSchema.parse({ ...currentSession, title: p.title })
      this.db
        .prepare('UPDATE sessions SET body=? WHERE session_id=?')
        .run(JSON.stringify(updated), session)
      this.append(session, 'session.updated', installationActor, updated)
      this.append('catalog', 'session.updated', installationActor, updated)
      return updated
    }
    if (method === 'session.delete') {
      return this.deleteSession(actor, session)
    }
    if (method === 'session.detach') {
      this.resources.targets.detach(session)
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
    if (method === 'session.configure') {
      if (
        !this.claude.live.handles(session) &&
        this.db
          .prepare(
            "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
          )
          .get(session)
      )
        throw new ChannelError('resource_busy')
      // Choosing how a session's tools are authorized is execution authority, not display.
      this.authority.check(actor, 'execute', session)
      const settings = p.settings as SessionSettings
      if (
        !this.claude.live.handles(session) &&
        Object.keys(settings).some((key) => key !== 'permission_mode')
      )
        throw new ChannelError('unsupported_method')
      this.claude.live.validate(session, settings)
      const before = this.claude.live.effective(session)
      const updated = SessionSchema.parse({
        ...currentSession,
        settings: { ...(currentSession.settings ?? {}), ...settings },
        tool_permissions: this.claude.permissionPolicy(currentSession.provider, {
          ...(currentSession.settings ?? {}),
          ...settings,
          permission_mode:
            settings.permission_mode ??
            currentSession.settings?.permission_mode ??
            currentSession.tool_permissions?.permission_mode ??
            'manual',
        }),
      })
      this.db
        .prepare('UPDATE sessions SET body=? WHERE session_id=?')
        .run(JSON.stringify(updated), session)
      this.append(session, 'session.updated', installationActor, updated)
      this.append('catalog', 'session.updated', installationActor, updated)
      this.delegations.permissionsChanged(session, updated.tool_permissions!)
      const after = this.claude.live.effective(session)
      queueMicrotask(() => this.claude.live.applied(session, before, after))
      return updated
    }
    if (method === 'session.owner_restart') {
      // Only the authenticated owner request boundary supplies a profile. Internal
      // model bridges admit ordinary inputs, and never export this method.
      if (!actor.profile) throw new ChannelError('unauthorized')
      const current = this.session(session)
      if (!current.owner_stopped || current.stop_generation !== p.stop_generation)
        throw new ChannelError('stale_revision')
      const refusal = this.resources.targets.refusal(
        session,
        p.expected_target as ExpectedExecutionTarget | undefined
      )
      if (refusal) return refusal
      if (this.claude.hasExecution(session) && this.claude.live.state(session).process !== 'idle')
        throw new ChannelError('resource_busy')
      // Use the same atomic owner admission as legacy session.send.
      const { stop_generation: _generation, ...input } = p
      return this.mutate(actor, 'session.send', { ...input, script: [{ kind: 'echo' }] }, true)
    }
    if (method === 'session.stop') {
      this.recordOwnerStop(session, actor)
      this.append(session, 'session.stop_requested', installationActor, { session_id: session })
      return this.claude.live.stopRequested(session)
    }
    if (method === 'session.compact') {
      if (!this.claude.live.handles(session)) throw new ChannelError('unsupported_method')
      const focus = typeof p.focus === 'string' ? p.focus.trim() : ''
      return this.mutate(
        actor,
        'session.send',
        {
          session_id: session,
          text: focus ? `/compact ${focus}` : '/compact',
          observed_seq: this.head(session),
          script: [{ kind: 'echo' }],
          compact: true,
          ...(typeof p.continue === 'boolean' ? { continue: p.continue } : {}),
        },
        ownerInput
      )
    }
    if (method === 'session.send') {
      const stopped = this.ownerStopRefusal(session)
      // This flag comes only from the validated owner request/operation boundary.
      // Delegations and model tools use acceptInput, even with the same authority.
      if (stopped && !ownerInput) return stopped
      if (this.chatCheckpoints.busy.has(session)) throw new ChannelError('resource_busy')
      const refusal = this.resources.targets.refusal(
        session,
        p.expected_target as ExpectedExecutionTarget | undefined
      )
      if (refusal) return refusal
      const current = this.session(session)
      this.resources.targets.checkSession(session)
      if (current.workspace_id) this.resources.workspaces.assertLease(current.workspace_id, session)
      if (current.provider !== 'fake') {
        if (!current.workspace_id && !this.resources.targets.bound(session))
          throw new ChannelError('workspace_required')
        if (!this.claude.isAvailable(current.provider))
          throw new ChannelError('provider_unavailable')
        if (canonical(p.script) !== canonical([{ kind: 'echo' }]))
          throw new ChannelError('invalid_params')
      }
      if (Number(p.observed_seq) > this.head(session)) throw new ChannelError('stale_revision')
      if (stopped)
        this.db.prepare('UPDATE session_owner_stops SET stopped=0 WHERE session_id=?').run(session)
      const input_id = randomUUID()
      const event = this.append(session, 'input.accepted', installationActor, {
        input_id,
        text: p.text,
        observed_seq: p.observed_seq,
        ...(p.sender ? { sender: p.sender } : {}),
        // Written by another owner session through the node's own tool, never by a client.
        ...(p.from_session ? { from_session: p.from_session } : {}),
      })
      this.db
        .prepare(
          'INSERT INTO inputs(input_id,session_id,principal_id,state,body) VALUES(?,?,?,?,?)'
        )
        .run(input_id, session, actor.installation_id, 'accepted', JSON.stringify(p))
      const input = this.db.prepare('SELECT * FROM inputs WHERE input_id=?').get(input_id) as Row
      this.transition(input, 'queued')
      if (stopped) {
        this.append(session, 'session.owner_stop', installationActor, {
          session_id: session,
          stop_generation: stopped.stop_generation,
          owner_stopped: false,
          reason: null,
        })
        this.delegations.ownerRestarted(session)
      }
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
      if (prompt.kind === 'questionnaire') {
        if (p.value !== undefined || (p.choice === 'deny' && p.answers !== undefined))
          throw new ChannelError('invalid_params')
        const answers = p.answers as Prompt['answers']
        if (p.choice === 'allow') this.obsidianTools.validateQuestionnaireAnswer(prompt, answers)
        return this.resolvePrompt(
          prompt,
          'resolved',
          p.choice as 'allow' | 'deny',
          actor.installation_id,
          undefined,
          answers
        )
      }
      if (p.answers !== undefined) throw new ChannelError('invalid_params')
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
      this.recordOwnerStop(session, actor)
      this.claude.live.stopRequested(session)
      this.append(session, 'run.interrupted', installationActor, {
        input_id: input.input_id,
        reason: 'stopped_by_owner',
        outcome: 'not_dispatched',
      })
      return { input_id: p.input_id, state: 'cancelled' }
    }
    if (method === 'session.interrupt') {
      // Rollback also removes this intent for an invalid/stale run. No external
      // cleanup is scheduled until the run identity has been checked below.
      this.recordOwnerStop(session, actor, false)
      if (this.claude.live.interruptRequested(session, String(p.run_id))) {
        return { run_id: p.run_id, state: 'interrupting' }
      }
      const input = this.db
        .prepare(
          "SELECT * FROM inputs WHERE session_id=? AND run_id=? AND state IN ('dispatching','delivered')"
        )
        .get(session, String(p.run_id)) as Row | undefined
      if (!input) throw new ChannelError('stale_revision')
      this.debuggerControl.revokeRunInTransaction(String(p.run_id))
      this.transition(
        input,
        this.session(session).provider !== 'fake' ? 'delivery_unknown' : 'interrupted'
      )
      if (this.session(session).provider === 'fake')
        this.resources.targets.settle(session, String(p.run_id))
      this.append(session, 'run.interrupted', installationActor, {
        run_id: p.run_id,
        outcome: 'unknown',
        reason: 'stopped_by_owner',
      })
      for (const prompt of this.prompts(session))
        if (prompt.state === 'pending' && prompt.run_id === p.run_id)
          this.resolvePrompt(prompt, 'invalidated', 'deny', null)
      return { run_id: p.run_id, state: 'interrupted' }
    }
    throw new ChannelError('unsupported_method')
  }
  session(id: string) {
    const row = this.db
      .prepare(
        'SELECT body FROM sessions WHERE session_id=? AND session_id NOT IN (SELECT session_id FROM deleted_sessions)'
      )
      .get(id) as Row | undefined
    if (!row) throw new ChannelError('not_found')
    const stop = this.db
      .prepare('SELECT generation,stopped FROM session_owner_stops WHERE session_id=?')
      .get(id)
    return SessionSchema.parse({
      ...JSON.parse(String(row.body)),
      ...(stop
        ? {
            stop_generation: Number(stop.generation),
            owner_stopped: !!stop.stopped,
            stop_reason: stop.stopped ? 'stopped_by_owner' : null,
          }
        : {}),
    })
  }
  ownerStopRefusal(session_id: string) {
    const session = this.session(session_id)
    return session.owner_stopped
      ? {
          code: 'owner_restart_required' as const,
          session_id,
          reason: 'stopped_by_owner' as const,
          stop_generation: session.stop_generation!,
        }
      : null
  }
  /** Inside the owner mutation transaction; independent of provider cleanup/outcomes. */
  private recordOwnerStop(session_id: string, authority: AuthorityContext, interruptActive = true) {
    const current = this.session(session_id)
    const stop_generation = (current.stop_generation ?? 0) + 1
    if (!Number.isSafeInteger(stop_generation)) throw new ChannelError('resource_busy')
    this.db
      .prepare(
        'INSERT INTO session_owner_stops VALUES(?,?,1) ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,stopped=1'
      )
      .run(session_id, stop_generation)
    const actor = { kind: 'installation' as const, installation_id: authority.installation_id }
    this.append(session_id, 'session.owner_stop', actor, {
      session_id,
      stop_generation,
      owner_stopped: true,
      reason: 'stopped_by_owner',
    })
    for (const input of this.db
      .prepare(
        "SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
      )
      .all(session_id) as Row[]) {
      if (['accepted', 'queued'].includes(String(input.state))) this.transition(input, 'cancelled')
      else if (input.state === 'dispatching' && this.claude.live.handles(session_id))
        // May be awaiting a checkpoint or an acknowledgement. Never replay it
        // when a fresh owner message releases the fence before that await ends.
        this.transition(input, 'delivery_unknown')
      else if (interruptActive && !this.claude.live.handles(session_id)) {
        this.transition(input, current.provider === 'fake' ? 'interrupted' : 'delivery_unknown')
        this.debuggerControl.revokeRunInTransaction(String(input.run_id))
        if (current.provider === 'fake')
          this.resources.targets.settle(session_id, String(input.run_id))
      }
    }
    for (const prompt of this.prompts(session_id))
      if (prompt.state === 'pending') this.resolvePrompt(prompt, 'invalidated', 'deny', null)
    this.delegations.ownerStopped(session_id, stop_generation)
    this.obsidianTools.cancelRunInTransaction(session_id, authority.installation_id)
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
    value?: string,
    answers?: Prompt['answers']
  ): Prompt {
    const result = PromptSchema.parse({
      ...prompt,
      state,
      choice,
      installation_id: installation,
      ...(value !== undefined ? { value } : {}),
      ...(answers !== undefined ? { answers } : {}),
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
    if (result.kind === 'questionnaire') {
      this.obsidianTools.questionnaireAnsweredInTransaction(result)
      return this.prompt(result.prompt_id)
    }
    return result
  }
  workspaceProvisioning(session_id: string) {
    const session = this.session(session_id)
    return (
      !!session.workspace_id &&
      this.resources.workspaces.get(session.workspace_id).state === 'provisioning'
    )
  }
  checkExecution(
    installation_id: string,
    session_id: string,
    expected_target?: ExpectedExecutionTarget
  ) {
    const actor = { installation_id }
    this.authority.check(actor, 'execute', session_id)
    if (this.ownerStopRefusal(session_id)) throw new ChannelError('owner_restart_required')
    if (this.resources.targets.refusal(session_id, expected_target))
      throw new ChannelError('target_changed')
    const session = this.session(session_id)
    if (session.workspace_id) {
      this.resources.workspaces.assertLease(session.workspace_id, session_id)
      if (this.resources.workspaces.get(session.workspace_id).state !== 'ready')
        throw new ChannelError('resource_busy')
    }
    this.resources.targets.checkSession(session_id)
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
          expected_target?: ExpectedExecutionTarget
        }
        if (input.state === 'queued' || input.state === 'accepted') {
          try {
            this.checkExecution(
              String(input.principal_id),
              String(input.session_id),
              body.expected_target
            )
          } catch {
            this.transition(input, 'cancelled')
            continue
          }
          const binding = this.resources.targets.bound(String(input.session_id))
          if (binding && !this.resources.targets.canLease(binding, String(input.session_id)))
            continue
          input.run_id = randomUUID()
          if (
            binding &&
            !this.resources.targets.lease(binding, String(input.session_id), String(input.run_id))
          )
            continue
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
                expires_at: this.delegations.isActive(String(input.session_id))
                  ? Number.MAX_SAFE_INTEGER
                  : now + action.ttl_ms,
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
          this.resources.targets.settle(String(input.session_id), String(input.run_id))
          this.append(String(input.session_id), failed ? 'run.failed' : 'run.completed', actor, {
            run_id: input.run_id,
          })
          const reply = this.db
            .prepare(
              "SELECT seq FROM events WHERE stream_id=? AND json_extract(body,'$.type')='content.delta' AND json_extract(body,'$.data.run_id')=? ORDER BY seq DESC LIMIT 1"
            )
            .get(String(input.session_id), String(input.run_id)) as { seq: number } | undefined
          this.append(String(input.session_id), 'input.reply', nodeActor, {
            input_id: String(input.input_id),
            run_id: String(input.run_id),
            turn_id: String(input.run_id),
            outcome: failed ? 'failed' : 'success',
            final_reply: reply
              ? { message_id: String(input.input_id), event_seqs: [reply.seq] }
              : null,
          })
        }
      }
      this.delegations.settle()
    })
  }
}

export { install as installLsp, status as lspStatus, popular as popularLsp } from './lsp/servers.js'
