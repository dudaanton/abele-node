import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  PromptSchema,
  type Prompt,
  type CommandRunRequest,
  type GitIntegrateRequest,
} from '@abele/node-protocol'
import { canonical, type NodeCore } from './index.js'
import type { ResolvedExecutionTarget } from './execution-targets.js'
import { OwnerGit } from './git-owner.js'

type Params = CommandRunRequest | GitIntegrateRequest
interface CommandContext {
  context_id: string
  parent_chat_id: string
  installation_id: string
  project_id?: string
  worktree_id?: string
  target: ResolvedExecutionTarget
}
interface Run {
  context_id?: string
  permission_mode?: 'ask' | 'bypass'
  justification?: string
  run_id: string
  prompt_id: string
  session_id: string
  method: string
  params: Params
  controller: AuthorityContext
  target: ResolvedExecutionTarget
  source?: ResolvedExecutionTarget
  cwd: string
  cwd_fingerprint: string
  state: string
  reason?: string
  stdout: string
  stderr: string
  stdout_truncated: boolean
  stderr_truncated: boolean
  exit_code?: number | null
  signal?: string | null
  head?: string
  conflicting_files?: string[]
}
const node = { kind: 'node' } as const
const terminal = (run: Run) => !['pending_approval', 'running'].includes(run.state)
// Deliberately do not inherit daemon credentials, provider tokens, NODE_OPTIONS or GIT_*.
const ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TERM|COLORTERM|CI|NO_COLOR)$/

/** Exact approval-backed effects, with durable receipts and no replay of interrupted effects. */
export class ManagerService {
  private active = new Map<
    string,
    { done: Promise<void>; stop: (reason: string) => void; owner: AuthorityContext }
  >()
  private closed = false
  private stopping = false
  constructor(private core: NodeCore) {
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS manager_runs(run_id TEXT PRIMARY KEY, body TEXT NOT NULL)'
    )
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS command_contexts(context_id TEXT PRIMARY KEY, owner TEXT NOT NULL, parent TEXT NOT NULL, target_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,parent,target_key))'
    )
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS command_context_prompts(prompt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES streams(stream_id), run_id TEXT NOT NULL, body TEXT NOT NULL)'
    )
    for (const row of core.db.prepare('SELECT body FROM manager_runs').all() as {
      body: string
    }[]) {
      const run = JSON.parse(row.body) as Run
      if (
        !terminal(run) &&
        !(run.context_id && run.permission_mode === 'ask' && run.state === 'pending_approval')
      ) {
        run.state = 'outcome_unknown'
        run.reason = 'daemon_restart'
        this.save(run)
        this.event(run)
      }
    }
    core.authority.subscribeInvalidation(() => {
      this.notifyPermissions()
    })
  }
  notifyPermissions() {
    if (this.closed) return
    for (const [id, active] of this.active) {
      const run = this.get(id)
      try {
        this.core.authority.check(active.owner, 'approve', run.session_id)
        this.check(run)
      } catch {
        active.stop('unauthorized')
      }
    }
  }
  close() {
    this.closed = true
    for (const active of this.active.values()) active.stop('node_shutdown')
  }
  async settled() {
    await Promise.allSettled([...this.active.values()].map((a) => a.done))
  }
  /** Stop and reap commands before shutting down the database. */
  async stop() {
    this.stopping = true
    for (const active of this.active.values()) active.stop('node_shutdown')
    await this.settled()
  }
  private get(id: string): Run {
    const row = this.core.db.prepare('SELECT body FROM manager_runs WHERE run_id=?').get(id) as
      { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return JSON.parse(row.body) as Run
  }
  private save(run: Run) {
    this.core.db
      .prepare(
        'INSERT INTO manager_runs VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body'
      )
      .run(run.run_id, JSON.stringify(run))
  }
  private view(run: Run) {
    const {
      params: _params,
      controller: _controller,
      target: _target,
      source: _source,
      cwd: _cwd,
      cwd_fingerprint: _cwdFingerprint,
      ...status
    } = run
    return {
      ...status,
      stdout: (run.stdout_truncated ? '[truncated]\n' : '') + run.stdout,
      stderr: (run.stderr_truncated ? '[truncated]\n' : '') + run.stderr,
    }
  }
  private event(run: Run, type = 'command.updated', data: unknown = this.view(run)) {
    if (!this.closed) this.core.append(run.session_id, type, node, data)
  }
  private check(run: Run) {
    this.core.assertAuditStorageAvailable()
    this.core.authority.check(run.controller, 'execute', run.session_id)
    for (const binding of [run.target, run.source].filter(
      (b): b is ResolvedExecutionTarget => !!b
    )) {
      this.core.authority.check(
        run.controller,
        'execute',
        binding.target.kind === 'worktree' ? binding.target.worktree_id : ''
      )
      this.core.authority.check(run.controller, 'execute', binding.project_id)
      const project = this.core.resources.targets.check(binding, false)
      if (project.trust !== 'trusted') throw new ChannelError('project_untrusted')
    }
    if (this.cwd(run.target.path, 'cwd' in run.params ? run.params.cwd : undefined) !== run.cwd)
      throw new ChannelError('stale_resource')
    if (this.cwdFingerprint(run.cwd) !== run.cwd_fingerprint)
      throw new ChannelError('stale_resource')
  }
  private cwdFingerprint(path: string) {
    const stat = statSync(path)
    if (!stat.isDirectory()) throw new ChannelError('unsafe_path')
    return `${stat.dev}:${stat.ino}`
  }
  private cwd(root: string, cwd?: string) {
    let path: string
    try {
      path = realpathSync(resolve(root, cwd ?? '.'))
    } catch {
      throw new ChannelError('unsafe_path')
    }
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new ChannelError('unsafe_path')
    return path
  }
  private context(actor: AuthorityContext, p: Record<string, unknown>): CommandContext {
    const row = this.core.db
      .prepare('SELECT body FROM command_contexts WHERE context_id=?')
      .get(String(p.context_id)) as { body: string } | undefined
    if (!row)
      throw new ChannelError(
        'not_found',
        'Missing command context (session replacement); create a context first',
        { resource: 'context' }
      )
    const context = JSON.parse(row.body) as CommandContext
    if (
      context.installation_id !== actor.installation_id ||
      context.parent_chat_id !== p.parent_chat_id
    )
      throw new ChannelError('unauthorized')
    this.core.authority.check(actor, 'request', context.context_id)
    return context
  }
  checkContextPublication(actor: AuthorityContext, p: Record<string, unknown>) {
    this.core.authority.check(actor, 'publish')
    if (p.context_id) {
      const context = this.context(actor, p)
      if (p.run_id && this.get(String(p.run_id)).context_id !== context.context_id)
        throw new ChannelError('unauthorized')
      if (p.run_id)
        this.checkPublication(actor, { session_id: context.context_id, run_id: p.run_id })
    }
  }
  private async contextTarget(actor: AuthorityContext, p: Record<string, unknown>) {
    const resource = p.project_id ? 'project' : 'worktree'
    try {
      const target = p.project_id
        ? await this.projectTarget(actor, String(p.project_id))
        : await this.worktreeTarget(String(p.worktree_id))
      this.core.authority.check(actor, 'execute', target.project_id)
      this.core.authority.check(
        actor,
        'execute',
        target.target.kind === 'worktree' ? target.target.worktree_id : ''
      )
      if (this.core.resources.targets.check(target, false).trust !== 'trusted')
        throw new ChannelError('project_untrusted')
      return target
    } catch (error) {
      if (
        error instanceof ChannelError &&
        ['not_found', 'repository_unavailable', 'unsafe_path'].includes(error.code)
      )
        throw new ChannelError(
          error.code,
          `Missing or unavailable ${resource}; refresh the registered execution target`,
          { resource }
        )
      throw error
    }
  }
  async requestContext(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation?: string
  ) {
    this.core.authority.check(actor, 'request')
    this.core.assertAuditStorageAvailable()
    if (this.stopping || this.closed) throw new ChannelError('resource_busy', 'Node is stopping')
    if (method === 'command.context.v1.create') {
      const previous = this.core.operationReceipt(actor, method, p, operation)
      if (previous) return previous.result
      const target = await this.contextTarget(actor, p)
      return this.core.commitOperation(actor, method, p, operation, () => {
        const key = canonical({ project_id: p.project_id, worktree_id: p.worktree_id })
        const row = this.core.db
          .prepare('SELECT body FROM command_contexts WHERE owner=? AND parent=? AND target_key=?')
          .get(actor.installation_id, String(p.parent_chat_id), key) as { body: string } | undefined
        if (row) return this.contextView(JSON.parse(row.body) as CommandContext)
        const context: CommandContext = {
          context_id: randomUUID(),
          parent_chat_id: String(p.parent_chat_id),
          installation_id: actor.installation_id,
          ...(p.project_id
            ? { project_id: String(p.project_id) }
            : { worktree_id: String(p.worktree_id) }),
          target,
        }
        this.core.db.prepare('INSERT INTO streams(stream_id) VALUES(?)').run(context.context_id)
        this.core.db
          .prepare('INSERT INTO command_contexts VALUES(?,?,?,?,?)')
          .run(
            context.context_id,
            actor.installation_id,
            context.parent_chat_id,
            key,
            JSON.stringify(context)
          )
        this.core.append(
          context.context_id,
          'command.context.created',
          node,
          this.contextView(context)
        )
        return this.contextView(context)
      })
    }
    const context = this.context(actor, p)
    if (method === 'command.context.v1.prepare') {
      const {
        context_id: _id,
        parent_chat_id: _parent,
        permission_mode: _mode,
        justification: _why,
        ...command
      } = p
      const params = {
        ...command,
        session_id: context.context_id,
        ...(context.project_id
          ? { project_id: context.project_id }
          : { worktree_id: context.worktree_id }),
      }
      return this.request(actor, 'command.v1.run', params, operation, { context, original: p })
    }
    const run = this.get(String(p.run_id))
    if (run.context_id !== context.context_id) throw new ChannelError('unauthorized')
    if (method === 'command.context.v1.status') this.checkContextPublication(actor, p)
    if (method === 'command.context.v1.status') return this.contextRunView(run)
    if (method === 'command.context.v1.cancel') {
      return this.core.commitOperation(actor, method, p, operation, () => {
        if (!terminal(run)) {
          this.active.get(run.run_id)?.stop('cancelled')
          run.state = 'cancelled'
          this.save(run)
          const prompt = this.runPrompt(run)
          if (prompt.state === 'pending')
            this.resolveRunPrompt(run, prompt, 'invalidated', 'deny', null)
          this.event(run)
        }
        return this.contextRunView(run)
      })
    }
    if (method !== 'command.context.v1.execute') throw new ChannelError('unsupported_method')
    this.core.authority.check(actor, 'approve', context.context_id)
    const result = this.core.commitOperation(actor, method, p, operation, () => {
      const prompt = this.runPrompt(run)
      if (run.permission_mode !== 'ask' || p.action_digest !== prompt.action_digest)
        throw new ChannelError('stale_approval')
      if (prompt.state !== 'pending' || run.state !== 'pending_approval')
        throw new ChannelError('stale_approval')
      return this.resolveRunPrompt(
        run,
        prompt,
        'resolved',
        p.choice as 'allow' | 'deny',
        actor.installation_id
      )
    }) as Prompt
    this.answered(result, actor)
    return result
  }
  private contextView(context: CommandContext) {
    const { target: _target, installation_id: _owner, ...view } = context
    return { ...view, stream_id: context.context_id }
  }
  private contextRunView(run: Run) {
    return {
      ...this.view(run),
      approval: run.permission_mode === 'ask' ? this.runPrompt(run) : null,
    }
  }
  private runPrompt(run: Run): Prompt {
    if (!run.context_id) return this.core.prompt(run.prompt_id)
    const row = this.core.db
      .prepare('SELECT body FROM command_context_prompts WHERE prompt_id=?')
      .get(run.prompt_id) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found', 'Missing command approval')
    return PromptSchema.parse(JSON.parse(row.body))
  }
  private resolveRunPrompt(
    run: Run,
    prompt: Prompt,
    state: Prompt['state'],
    choice: 'allow' | 'deny',
    installation: string | null
  ) {
    if (!run.context_id) return this.core.resolvePrompt(prompt, state, choice, installation)
    const result = PromptSchema.parse({ ...prompt, state, choice, installation_id: installation })
    this.core.db
      .prepare('UPDATE command_context_prompts SET body=? WHERE prompt_id=?')
      .run(JSON.stringify(result), prompt.prompt_id)
    this.core.append(
      run.session_id,
      'prompt.' + state,
      installation ? { kind: 'installation', installation_id: installation } : node,
      result
    )
    return result
  }
  checkPublication(actor: AuthorityContext, p: Record<string, unknown>) {
    this.core.authority.check(actor, 'publish', String(p.session_id))
    if (p.run_id) {
      const run = this.get(String(p.run_id))
      if (run.session_id !== p.session_id) throw new ChannelError('not_found')
      if (run.target.target.kind === 'worktree')
        this.core.resources.repository.checkPublication(actor, {
          worktree_id: run.target.target.worktree_id,
        })
      else this.core.authority.check(actor, 'publish', run.target.project_id)
    }
    if (p.worktree_id) this.core.resources.repository.checkPublication(actor, p)
  }
  private async worktreeTarget(worktree_id: string) {
    if (this.core.db.prepare('SELECT 1 FROM workspaces WHERE workspace_id=?').get(worktree_id))
      throw new ChannelError(
        'invalid_params',
        'Received workspace_id in a worktree field; use delegation.status.worktree_id after provisioning'
      )
    try {
      return await this.core.resources.targets.resolve({ kind: 'worktree', worktree_id })
    } catch (error) {
      if (error instanceof ChannelError && error.code === 'not_found')
        throw new ChannelError(
          'not_found',
          'Unknown worktree_id; refresh delegation.status or the project worktree catalogue'
        )
      throw error
    }
  }
  private async projectTarget(actor: AuthorityContext, project_id: string) {
    this.core.authority.check(actor, 'execute', project_id)
    const project = this.core.resources.projects.get(project_id)
    if (project.repository_path) {
      const trees = (await this.core.resources.request(actor, 'repository.v1.worktrees', {
        project_id,
        limit: 256,
      })) as { entries: { kind: string; worktree_id: string }[] }
      const root = trees.entries.find((t) => t.kind === 'root')
      if (!root) throw new ChannelError('repository_unavailable')
      return this.core.resources.targets.resolve({
        kind: 'worktree',
        worktree_id: root.worktree_id,
      })
    }
    const row = this.core.db
      .prepare(
        "SELECT workspace_id FROM workspaces WHERE project_id=? AND json_extract(body,'$.kind')='root' AND state='ready'"
      )
      .get(project_id) as { workspace_id: string } | undefined
    if (!row) throw new ChannelError('repository_unavailable')
    return this.core.resources.targets.resolve({
      kind: 'workspace',
      workspace_id: row.workspace_id,
    })
  }
  async request(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation?: string,
    commandContext?: { context: CommandContext; original: Record<string, unknown> }
  ) {
    this.core.authority.check(actor, 'request', String(p.session_id))
    if (!commandContext) {
      try {
        this.core.session(String(p.session_id))
      } catch (error) {
        if (error instanceof ChannelError && error.code === 'not_found')
          throw new ChannelError(
            'not_found',
            'Missing session; ordinary chats should use command_context_v1',
            { resource: 'session' }
          )
        throw error
      }
    }
    if (method === 'command.v1.status' || method === 'command.v1.cancel') {
      const run = this.get(String(p.run_id))
      if (run.session_id !== p.session_id) throw new ChannelError('not_found')
      this.checkPublication(actor, p)
      if (method === 'command.v1.cancel') {
        return this.core.commitOperation(actor, method, p, operation, () => {
          if (run.method === 'git.v1.integrate' && run.state === 'running')
            throw new ChannelError(
              'resource_busy',
              'Integration is already running; inspect its final result'
            )
          if (!terminal(run)) {
            this.active.get(run.run_id)?.stop('cancelled')
            run.state = 'cancelled'
            this.save(run)
            const prompt = this.runPrompt(run)
            if (prompt.state === 'pending')
              this.resolveRunPrompt(run, prompt, 'invalidated', 'deny', null)
            this.event(run)
          }
          return this.view(run)
        })
      }
      return this.view(run)
    }
    if (!operation || operation.length > 128) throw new ChannelError('operation_id_required')
    if (this.stopping || this.closed) throw new ChannelError('resource_busy', 'Node is stopping')
    const receiptMethod = commandContext ? 'command.context.v1.prepare' : method
    const receiptParams = commandContext?.original ?? p
    const previous = this.core.operationReceipt(actor, receiptMethod, receiptParams, operation)
    if (previous) return previous.result
    if (Buffer.byteLength(canonical(p)) > 32768)
      throw new ChannelError('invalid_params', 'Request exceeds 32768 bytes')
    const target = commandContext
      ? await this.contextTarget(actor, p)
      : p.project_id
        ? await this.projectTarget(actor, String(p.project_id))
        : await this.worktreeTarget(String(p.worktree_id))
    const source =
      method === 'git.v1.integrate'
        ? await this.worktreeTarget(String(p.source_worktree_id))
        : undefined
    if (source && (source.project_id !== target.project_id || source.path === target.path))
      throw new ChannelError('invalid_params')
    if (p.env)
      for (const [key, value] of Object.entries(p.env as Record<string, string>)) {
        if (!ENV.test(key) || value.includes('\0'))
          throw new ChannelError('invalid_params', 'Environment key is not allowed: ' + key)
      }
    let cwd: string
    try {
      cwd = this.cwd(target.path, p.cwd as string | undefined)
      this.cwdFingerprint(cwd)
    } catch (error) {
      if (commandContext)
        throw new ChannelError(
          'unsafe_path',
          'Missing or unsafe cwd; select a directory inside the execution target',
          { resource: 'cwd' }
        )
      throw error
    }
    const run: Run = {
      ...(commandContext
        ? {
            context_id: commandContext.context.context_id,
            permission_mode: commandContext.original.permission_mode as 'ask' | 'bypass',
            ...(commandContext.original.justification !== undefined
              ? { justification: String(commandContext.original.justification) }
              : {}),
          }
        : {}),
      run_id: randomUUID(),
      prompt_id: randomUUID(),
      session_id: String(p.session_id),
      method,
      params: p as unknown as Params,
      controller: this.core.authority.snapshot(actor),
      target,
      source,
      cwd,
      cwd_fingerprint: this.cwdFingerprint(cwd),
      state: commandContext?.original.permission_mode === 'bypass' ? 'running' : 'pending_approval',
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
    }
    this.check(run)
    for (const binding of [target, source])
      if (binding && this.core.resources.targets.leasedPath(binding.path))
        throw new ChannelError(
          'resource_busy',
          'Execution target is busy; retry after the active run ends.'
        )
    const result = this.core.commitOperation(actor, receiptMethod, receiptParams, operation, () => {
      this.check(run)
      const input = {
        method,
        params: p,
        ...(method === 'command.v1.run'
          ? {
              ...('command' in p ? { command: p.command } : {}),
              ...('argv' in p ? { argv: p.argv } : {}),
            }
          : {}),
        cwd: run.cwd,
        ...(commandContext
          ? {
              context_id: run.context_id,
              parent_chat_id: commandContext.context.parent_chat_id,
              permission_mode: run.permission_mode,
            }
          : {}),
        cwd_fingerprint: run.cwd_fingerprint,
        project_id: target.project_id,
        target_fingerprint: target.fingerprint,
        ...(source ? { source_fingerprint: source.fingerprint } : {}),
      }
      const prompt = PromptSchema.parse({
        prompt_id: run.prompt_id,
        session_id: run.session_id,
        run_id: run.run_id,
        revision: 1,
        action_digest: createHash('sha256').update(canonical(input)).digest('hex'),
        expires_at: Number.MAX_SAFE_INTEGER,
        state: run.permission_mode === 'bypass' ? 'resolved' : 'pending',
        choice: run.permission_mode === 'bypass' ? 'allow' : null,
        installation_id: run.permission_mode === 'bypass' ? actor.installation_id : null,
        delivered: false,
        tool_name: method,
        title:
          method === 'command.v1.run'
            ? 'Run command in trusted worktree'
            : 'Integrate developer branch',
        input,
      })
      this.save(run)
      this.core.db
        .prepare(
          `INSERT INTO ${run.context_id ? 'command_context_prompts' : 'prompts'} VALUES(?,?,?,?)`
        )
        .run(prompt.prompt_id, prompt.session_id, prompt.run_id, JSON.stringify(prompt))
      this.core.append(
        run.session_id,
        run.permission_mode === 'bypass' ? 'command.bypass' : 'prompt.opened',
        { kind: 'installation', installation_id: actor.installation_id },
        prompt
      )
      this.event(run)
      return commandContext ? this.contextRunView(run) : this.view(run)
    })
    if (run.permission_mode === 'bypass') {
      const row = this.core.db.prepare('SELECT 1 FROM manager_runs WHERE run_id=?').get(run.run_id)
      if (row) this.answered(this.runPrompt(run), actor)
    }
    return result
  }
  /** Called after prompt.answer has committed, never from inside its transaction. */
  answered(prompt: Prompt, owner: AuthorityContext) {
    const row = this.core.db
      .prepare('SELECT body FROM manager_runs WHERE run_id=?')
      .get(prompt.run_id) as { body: string } | undefined
    if (!row) return
    const run = JSON.parse(row.body) as Run
    const bypassAdmission =
      run.permission_mode === 'bypass' && run.state === 'running' && !this.runPrompt(run).delivered
    if (
      run.prompt_id !== prompt.prompt_id ||
      (run.state !== 'pending_approval' && !bypassAdmission)
    )
      return
    const allowed = !this.stopping && prompt.state === 'resolved' && prompt.choice === 'allow'
    // Claim and consume the reply atomically before yielding; duplicate answers cannot launch twice.
    run.state = allowed ? 'running' : 'denied'
    this.core.transaction(() => {
      this.core.db
        .prepare(
          `UPDATE ${run.context_id ? 'command_context_prompts' : 'prompts'} SET body=? WHERE prompt_id=?`
        )
        .run(JSON.stringify({ ...prompt, delivered: true }), prompt.prompt_id)
      this.core.append(run.session_id, 'prompt.delivered', node, {
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        choice: prompt.choice,
      })
      this.save(run)
      this.event(run)
    })
    if (!allowed) return
    let stopped: string | undefined
    let child: ChildProcess | undefined
    const stop = (reason: string) => {
      stopped = reason
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    const done = Promise.resolve().then(async () => {
      try {
        if (stopped) {
          run.state = 'cancelled'
          run.reason = stopped
          return
        }
        this.core.authority.check(owner, 'approve', run.session_id)
        for (const binding of [run.target, run.source].filter(
          (b): b is ResolvedExecutionTarget => !!b
        ))
          await this.core.resources.targets.resolve(binding.target)
        this.core.authority.check(owner, 'approve', run.session_id)
        this.check(run)
        if (stopped) {
          run.state = 'cancelled'
          run.reason = stopped
          return
        }
        this.core.transaction(() => {
          for (const binding of [run.target, run.source].filter(
            (b): b is ResolvedExecutionTarget => !!b
          )) {
            if (
              this.core.resources.targets.leasedPath(binding.path) ||
              !this.core.resources.targets.lease(binding, run.session_id, run.run_id)
            )
              throw new ChannelError('resource_busy')
          }
        })
        if (run.method === 'git.v1.integrate')
          await this.integrate(run, () => {
            if (stopped) throw new ChannelError('resource_busy', stopped)
            this.core.authority.check(owner, 'approve', run.session_id)
            this.check(run)
          })
        else
          await this.command(
            run,
            (c) => {
              child = c
              if (stopped) stop(stopped)
            },
            () => stopped,
            stop
          )
        if (stopped) {
          run.state =
            run.method === 'git.v1.integrate'
              ? 'outcome_unknown'
              : stopped === 'timed_out'
                ? 'timed_out'
                : 'cancelled'
          run.reason = stopped
        }
      } catch (error) {
        run.state = stopped
          ? run.method === 'git.v1.integrate'
            ? 'outcome_unknown'
            : 'cancelled'
          : 'failed'
        run.reason = stopped ?? (error instanceof ChannelError ? error.code : 'execution_failed')
      } finally {
        try {
          if (!this.closed) {
            this.core.resources.targets.settle(run.session_id, run.run_id)
            this.save(run)
            this.event(run)
          }
        } finally {
          this.active.delete(run.run_id)
        }
      }
    })
    this.active.set(run.run_id, { done, stop, owner: this.core.authority.snapshot(owner) })
    // Audit failure must stop the child, not become an unhandled background rejection.
    void done.catch(() => console.debug('[manager] Could not persist final run status', run.run_id))
  }
  private async command(
    run: Run,
    started: (child: ChildProcess) => void,
    stopped: () => string | undefined,
    stop: (reason: string) => void
  ) {
    const p = run.params as CommandRunRequest
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV.test(k)))
    Object.assign(env, p.env)
    const child = p.argv
      ? spawn(p.argv[0]!, p.argv.slice(1), {
          cwd: run.cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/sh', ['-c', p.command!], {
          cwd: run.cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    started(child)
    const timer = p.timeout_ms ? setTimeout(() => stop('timed_out'), p.timeout_ms) : undefined
    const cap = p.output_bytes ?? 16384
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const output = (stream: 'stdout' | 'stderr', text: string) => {
      if (this.closed || !text) return
      const bytes = Buffer.from(run[stream] + text)
      if (bytes.length > cap) {
        run[(stream + '_truncated') as 'stdout_truncated' | 'stderr_truncated'] = true
        run[stream] = bytes.subarray(-cap).toString('utf8').replace(/^�+/, '')
      } else run[stream] += text
      try {
        this.core.transaction(() => {
          this.save(run)
          for (let i = 0; i < text.length; i += 4096)
            this.event(run, 'command.output', {
              run_id: run.run_id,
              stream,
              text: text.slice(i, i + 4096),
            })
        })
      } catch {
        stop('storage_unavailable')
      }
    }
    child.stdout.on('data', (b: Buffer) => output('stdout', decoders.stdout.write(b)))
    child.stderr.on('data', (b: Buffer) => output('stderr', decoders.stderr.write(b)))
    try {
      await new Promise<void>((done, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => {
          run.exit_code = code
          run.signal = signal
          done()
        })
      })
      output('stdout', decoders.stdout.end())
      output('stderr', decoders.stderr.end())
      run.state = stopped() ?? 'exited'
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  private async integrate(run: Run, check: () => void) {
    const p = run.params as GitIntegrateRequest
    const git = new OwnerGit(this.core.resources.git.executable)
    const exec = (path: string, args: string[], probe = true) =>
      git.run(path, args, { probe, timeoutMs: 15000 })
    const text = async (path: string, args: string[]) => {
      const result = await exec(path, args)
      if (result.code) throw new ChannelError('git_failed', result.output)
      return result.stdout.toString('utf8').trim()
    }
    const target = run.target.path,
      source = run.source!.path
    // Share the ordinary mutation locks, in stable order across both worktrees.
    const paths = [target, source].sort()
    await this.core.resources.git.serialize('git-write:' + paths[0], () =>
      this.core.resources.git.serialize('git-write:' + paths[1], async () => {
        check()
        for (const [path, branch, head] of [
          [target, p.target_branch, p.expected_target_head],
          [source, p.source_branch, p.expected_source_head],
        ]) {
          for (const marker of ['rebase-merge', 'rebase-apply']) {
            if (existsSync(resolve(path!, await text(path!, ['rev-parse', '--git-path', marker]))))
              throw new ChannelError('resource_busy')
          }
          if ((await exec(path!, ['check-ref-format', '--branch', branch!])).code)
            throw new ChannelError('invalid_ref')
          if (
            (await text(path!, ['symbolic-ref', '-q', 'HEAD'])) !== 'refs/heads/' + branch ||
            (await text(path!, ['rev-parse', 'HEAD'])) !== head
          )
            throw new ChannelError('stale_revision')
          if (await text(path!, ['status', '--porcelain', '--untracked-files=all']))
            throw new ChannelError('workspace_dirty')
          for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
            if (!(await exec(path!, ['rev-parse', '-q', '--verify', marker])).code)
              throw new ChannelError('resource_busy')
          }
        }
        const ancestor = await exec(target, [
          'merge-base',
          '--is-ancestor',
          p.expected_target_head,
          p.expected_source_head,
        ])
        if (ancestor.code > 1) throw new ChannelError('git_failed', ancestor.output)
        let head = p.expected_source_head
        if (ancestor.code) {
          if (!p.rebase) {
            run.state = 'failed'
            run.reason = 'not_fast_forward'
            return
          }
          check()
          let rebased: Awaited<ReturnType<typeof exec>> | undefined
          let error: unknown
          try {
            rebased = await exec(
              source,
              [
                'rebase',
                '--no-autostash',
                '--no-update-refs',
                '--no-autosquash',
                p.expected_target_head,
              ],
              false
            )
          } catch (e) {
            error = e
          }
          if (!rebased || rebased.code) {
            try {
              run.conflicting_files = (
                await text(source, ['diff', '--name-only', '--diff-filter=U', '-z'])
              )
                .split('\0')
                .filter(Boolean)
            } finally {
              // Timeouts/output-limit failures also need rollback, not only ordinary conflicts.
              for (const marker of ['rebase-merge', 'rebase-apply']) {
                const path = await text(source, ['rev-parse', '--git-path', marker])
                if (existsSync(resolve(source, path)))
                  await exec(source, ['rebase', '--abort'], false)
              }
            }
            run.state = 'failed'
            run.reason =
              (await text(source, ['rev-parse', 'HEAD'])) !== p.expected_source_head ||
              (await text(source, ['status', '--porcelain', '--untracked-files=all']))
                ? 'rebase_cleanup_failed'
                : run.conflicting_files?.length
                  ? 'rebase_conflict'
                  : error instanceof ChannelError
                    ? error.code
                    : 'rebase_failed'
            return
          }
          head = await text(source, ['rev-parse', 'HEAD'])
        }
        check()
        if (
          (await text(target, ['rev-parse', 'HEAD'])) !== p.expected_target_head ||
          (await text(source, ['rev-parse', 'HEAD'])) !== head
        )
          throw new ChannelError('stale_revision')
        if (
          (await text(target, ['symbolic-ref', '-q', 'HEAD'])) !==
            'refs/heads/' + p.target_branch ||
          (await text(source, ['symbolic-ref', '-q', 'HEAD'])) !== 'refs/heads/' + p.source_branch
        )
          throw new ChannelError('stale_revision')
        if (await text(target, ['status', '--porcelain', '--untracked-files=all']))
          throw new ChannelError('workspace_dirty')
        try {
          const merged = await exec(target, ['merge', '--ff-only', '--no-autostash', head], false)
          run.head = await text(target, ['rev-parse', 'HEAD'])
          if (merged.code) {
            run.state = run.head === p.expected_target_head ? 'failed' : 'outcome_unknown'
            run.reason = 'git_failed'
            run.stderr = merged.output
          } else if (run.head !== head) {
            run.state = 'outcome_unknown'
            run.reason = 'stale_revision'
          } else run.state = 'applied'
        } catch (error) {
          // A timeout or lost reply can follow a successful ref write or a post-merge hook.
          run.state = 'outcome_unknown'
          run.reason = error instanceof ChannelError ? error.code : 'git_failed'
        }
      })
    )
  }
}
