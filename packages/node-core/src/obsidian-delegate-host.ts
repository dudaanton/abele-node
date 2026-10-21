import { createHash, randomUUID } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import {
  ObsidianDelegateArgumentsSchema,
  type ObsidianConfiguration,
  type ObsidianToolsSnapshot,
} from '@abele/node-protocol'
import type { NodeCore } from './index.js'
import type { Invocation } from './obsidian-tools.js'

type State = 'queued' | 'running' | 'done' | 'error' | 'aborted' | 'outcome_unknown'
interface Branch {
  branch_id: string
  invocation_id: string
  run_id: string
  root_id: string
  parent_branch_id?: string
  item: string
  task: string
  state: State
  depth: number
  depth_limit: number
  configuration: ObsidianToolsSnapshot
  parent_context: Record<string, unknown>
  last_seq: number
  result?: string
  error?: string
}
interface Run {
  task: string
  fan_out: boolean
  run_id: string
  invocation_id: string
  root_id: string
  call_id: string
  request_hash: string
  parent_branch_id?: string
  agent_name: string
  depth: number
  depth_limit: number
  batch_size: number
  branch_ids: string[]
}
const stable = (v: any): string =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? '[' + v.map(stable).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
          .join(',') +
        '}'
    : JSON.stringify(v)
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex')
const finished = (b: Branch) => b.state !== 'queued' && b.state !== 'running'

/** Durable minimal conversation host. Vault-agent inference stays in the plugin;
 * admission, root budget, branch claims and ordinary history belong to the node. */
export class ObsidianDelegateHost {
  constructor(
    private core: NodeCore,
    private host: {
      config(session: string): ObsidianConfiguration
      save(i: Invocation): Invocation
    }
  ) {
    core.db
      .exec(`CREATE TABLE IF NOT EXISTS obsidian_delegate_roots(root_id TEXT PRIMARY KEY, used_runs INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS obsidian_delegate_runs(run_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, call_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(invocation_id,call_id));
      CREATE TABLE IF NOT EXISTS obsidian_delegate_branches(branch_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obsidian_delegate_history(branch_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(branch_id,seq));
      CREATE TABLE IF NOT EXISTS obsidian_delegate_records(branch_id TEXT NOT NULL, record_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(branch_id,record_id));`)
  }
  private runs(id: string): Run[] {
    return this.core.db
      .prepare('SELECT body FROM obsidian_delegate_runs WHERE invocation_id=? ORDER BY rowid')
      .all(id)
      .map((r) => JSON.parse(String(r.body)))
  }
  private branches(id: string): Branch[] {
    return this.core.db
      .prepare('SELECT body FROM obsidian_delegate_branches WHERE invocation_id=? ORDER BY rowid')
      .all(id)
      .map((r) => JSON.parse(String(r.body)))
  }
  private branch(i: Invocation, id: string): Branch {
    const row = this.core.db
      .prepare('SELECT body FROM obsidian_delegate_branches WHERE branch_id=? AND invocation_id=?')
      .get(id, i.invocation_id)
    if (!row) throw new ChannelError('not_found')
    return JSON.parse(String(row.body))
  }
  private save(b: Branch) {
    this.core.db
      .prepare('UPDATE obsidian_delegate_branches SET body=? WHERE branch_id=?')
      .run(JSON.stringify(b), b.branch_id)
    this.core.append(
      this.session(b.invocation_id),
      'obsidian.tools.delegate.progress',
      { kind: 'node' },
      {
        invocation_id: b.invocation_id,
        run_id: b.run_id,
        branch_id: b.branch_id,
        state: b.state,
        last_seq: b.last_seq,
      }
    )
  }
  private session(id: string): string {
    return String(
      this.core.db
        .prepare('SELECT session_id FROM obsidian_tool_invocations WHERE invocation_id=?')
        .get(id)!.session_id
    )
  }
  private used(root: string) {
    return Number(
      this.core.db
        .prepare('SELECT used_runs FROM obsidian_delegate_roots WHERE root_id=?')
        .get(root)?.used_runs ?? 0
    )
  }
  private view(run: Run) {
    const { request_hash: _hash, ...publicRun } = run
    const branches = this.branches(run.invocation_id).filter((b) => b.run_id === run.run_id)
    return {
      ...publicRun,
      configuration: branches[0]?.configuration,
      parent_context: branches[0]?.parent_context,
      branches: branches.map((b) => this.metadata(b)),
      used_runs: this.used(run.root_id),
      status: branches.every(finished)
        ? branches.some((b) => ['error', 'outcome_unknown'].includes(b.state))
          ? 'error'
          : branches.some((b) => b.state === 'aborted')
            ? 'aborted'
            : 'done'
        : 'running',
    }
  }
  private metadata(b: Branch) {
    const {
      configuration: _config,
      parent_context: _context,
      task: _task,
      result: _result,
      error: _error,
      ...metadata
    } = b
    return metadata
  }
  private executionMetadata(b: Branch) {
    const { item: _item, ...metadata } = this.metadata(b)
    return metadata
  }
  get(i: Invocation, runId?: string) {
    if (runId) {
      const run = this.runs(i.invocation_id).find((r) => r.run_id === runId)
      if (!run) throw new ChannelError('not_found')
      return this.view(run)
    }
    return {
      root_id: i.session_id,
      used_runs: this.used(i.session_id),
      cancelled: !!i.cancel_requested,
      runs: this.runs(i.invocation_id).map((r) => {
        const {
          task: _task,
          configuration: _config,
          parent_context: _context,
          branches: _branches,
          ...summary
        } = this.view(r)
        return summary
      }),
    }
  }
  begin(i: Invocation, p: any) {
    if (i.tool_name !== 'delegate') throw new ChannelError('invalid_params')
    const old = this.runs(i.invocation_id).find((r) => r.call_id === p.call_id)
    if (i.cancel_requested) throw new ChannelError('cancelled')
    if (old) {
      if (old.request_hash !== hash(p)) throw new ChannelError('operation_conflict')
      return this.view(old)
    }
    if (i.state !== 'executing') throw new ChannelError('operation_conflict')
    const parent = p.parent_branch_id ? this.branch(i, p.parent_branch_id) : undefined
    if (parent && parent.state !== 'running') throw new ChannelError('operation_conflict')
    if (!parent && this.runs(i.invocation_id).some((r) => !r.parent_branch_id))
      throw new ChannelError('operation_conflict')
    const configuration = parent?.configuration ?? this.host.config(i.session_id)
    if (parent) {
      const mode = configuration.tools.find((tool) => tool.name === 'delegate')?.mode ?? 'off'
      if (mode !== 'auto')
        throw new ChannelError(mode === 'off' ? 'tool_disabled' : 'delegate_approval_required')
    }
    const depth = parent?.depth ?? 0
    const limit = Math.min(3, parent?.depth_limit ?? 3, configuration.max_delegate_depth ?? 0)
    if (depth >= limit) throw new ChannelError('delegate_depth_exceeded')
    const parsed = ObsidianDelegateArgumentsSchema.safeParse(parent ? p.arguments : i.arguments)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const args = parsed.data
    if (
      args.agent.trim().toLowerCase() !== p.agent_name.trim().toLowerCase() &&
      args.agent !== p.target.agent_id
    )
      throw new ChannelError('invalid_params')
    if (p.target.vault_id !== i.vault_id) throw new ChannelError('wrong_vault')
    const work = args.items?.length ? args.items : [args.task]
    const used = this.used(i.session_id)
    if (used + work.length > 50) throw new ChannelError('delegate_budget_exceeded')
    const rank = { off: 0, ask: 1, auto: 2 }
    const target: ObsidianToolsSnapshot = p.target
    const tools = target.tools.map((t) => {
      const ceiling = configuration.tools.find((parent) => parent.name === t.name)?.mode ?? 'off'
      return { ...t, mode: rank[t.mode] <= rank[ceiling] ? t.mode : ceiling }
    })
    const childConfiguration = {
      ...target,
      tools,
      revision: 'host:' + hash([configuration.revision, target, tools]).slice(0, 40),
    }
    const run: Run = {
      task: args.task,
      fan_out: !!args.items?.length,
      run_id: randomUUID(),
      invocation_id: i.invocation_id,
      root_id: i.session_id,
      call_id: p.call_id,
      request_hash: hash(p),
      ...(parent ? { parent_branch_id: parent.branch_id } : {}),
      agent_name: p.agent_name,
      depth: depth + 1,
      depth_limit: limit,
      batch_size: Math.min(10, Math.max(1, Math.floor(args.batch_size || 5))),
      branch_ids: [],
    }
    for (const item of work) {
      const branch: Branch = {
        branch_id: randomUUID(),
        invocation_id: i.invocation_id,
        run_id: run.run_id,
        root_id: run.root_id,
        ...(parent ? { parent_branch_id: parent.branch_id } : {}),
        item,
        task: args.items?.length ? `${args.task}\n\n${item}` : item,
        state: 'queued',
        depth: run.depth,
        depth_limit: limit,
        configuration: childConfiguration,
        parent_context: configuration.conversation ?? {},
        last_seq: 0,
      }
      run.branch_ids.push(branch.branch_id)
      this.core.db
        .prepare('INSERT INTO obsidian_delegate_branches VALUES(?,?,?,?)')
        .run(branch.branch_id, i.invocation_id, run.run_id, JSON.stringify(branch))
    }
    this.core.db
      .prepare(
        'INSERT INTO obsidian_delegate_roots VALUES(?,?) ON CONFLICT(root_id) DO UPDATE SET used_runs=excluded.used_runs'
      )
      .run(run.root_id, used + work.length)
    this.core.db
      .prepare('INSERT INTO obsidian_delegate_runs VALUES(?,?,?,?)')
      .run(run.run_id, i.invocation_id, run.call_id, JSON.stringify(run))
    i.hosted = 'delegate'
    this.host.save(i)
    this.core.append(
      i.session_id,
      'obsidian.tools.delegate',
      { kind: 'node' },
      {
        invocation_id: i.invocation_id,
        run_id: run.run_id,
        root_id: run.root_id,
        branch_ids: run.branch_ids,
        depth: run.depth,
        used_runs: used + work.length,
      }
    )
    return this.view(run)
  }
  claim(i: Invocation, id: string) {
    const branch = this.branch(i, id)
    if (branch.state !== 'queued' || i.cancel_requested || i.state !== 'executing')
      return { execute: false, branch: { ...this.executionMetadata(branch), task: branch.task } }
    // The returned batch size also binds physical admission, including reconnects.
    const run = this.runs(i.invocation_id).find((r) => r.run_id === branch.run_id)!
    if (
      this.branches(i.invocation_id).filter((b) => b.run_id === run.run_id && b.state === 'running')
        .length >= run.batch_size
    )
      throw new ChannelError('delegate_batch_limit')
    branch.state = 'running'
    this.save(branch)
    return { execute: true, branch: { ...this.executionMetadata(branch), task: branch.task } }
  }
  record(i: Invocation, p: any) {
    const branch = this.branch(i, p.branch_id)
    const old = this.core.db
      .prepare(
        'SELECT request_hash,result FROM obsidian_delegate_records WHERE branch_id=? AND record_id=?'
      )
      .get(branch.branch_id, p.record_id)
    if (old) {
      if (old.request_hash !== hash(p)) throw new ChannelError('operation_conflict')
      return JSON.parse(String(old.result))
    }
    if (finished(branch) || (branch.state === 'queued' && p.state !== 'aborted'))
      throw new ChannelError('operation_conflict')
    for (const message of p.messages) {
      this.core.db
        .prepare('INSERT INTO obsidian_delegate_history VALUES(?,?,?)')
        .run(branch.branch_id, ++branch.last_seq, JSON.stringify(message))
    }
    if (p.state !== 'running') {
      // A parent cannot finish while its nested work is still running.
      const children = this.runs(i.invocation_id).filter(
        (r) => r.parent_branch_id === branch.branch_id
      )
      if (children.some((r) => this.view(r).status === 'running'))
        throw new ChannelError('delegate_children_running')
      branch.state = p.state
      if (p.result !== undefined) branch.result = p.result
      if (p.error !== undefined) branch.error = p.error
    }
    this.save(branch)
    const result = { branch_id: branch.branch_id, state: branch.state, last_seq: branch.last_seq }
    this.core.db
      .prepare('INSERT INTO obsidian_delegate_records VALUES(?,?,?,?)')
      .run(branch.branch_id, p.record_id, hash(p), JSON.stringify(result))
    this.finish(i)
    return result
  }
  history(i: Invocation, p: any) {
    const branch = this.branch(i, p.branch_id)
    const rows = this.core.db
      .prepare(
        'SELECT seq,body FROM obsidian_delegate_history WHERE branch_id=? AND seq>? ORDER BY seq LIMIT ?'
      )
      .all(branch.branch_id, p.after_seq, p.limit)
      .map((r) => ({ seq: Number(r.seq), message: JSON.parse(String(r.body)) }))
    const entries: typeof rows = []
    let bytes = 0
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (bytes + size > 200 * 1024) break
      entries.push(row)
      bytes += size
    }
    return {
      branch: this.executionMetadata(branch),
      entries,
      next_seq: entries.at(-1)?.seq ?? p.after_seq,
      has_more: (entries.at(-1)?.seq ?? p.after_seq) < branch.last_seq,
    }
  }
  details(i: Invocation, id: string) {
    const branch = this.branch(i, id)
    return {
      ...this.executionMetadata(branch),
      ...(!finished(branch) ? { task: branch.task } : {}),
      result: branch.result,
      error: branch.error,
    }
  }
  cancel(i: Invocation) {
    for (const branch of this.branches(i.invocation_id))
      if (branch.state === 'queued') {
        branch.state = 'aborted'
        this.save(branch)
      }
    this.finish(i)
  }
  private finish(i: Invocation) {
    const branches = this.branches(i.invocation_id)
    if (!branches.length || !branches.every(finished)) return
    const root = this.runs(i.invocation_id).find((r) => !r.parent_branch_id)!
    const top = branches.filter((b) => b.run_id === root.run_id)
    i.state = i.cancel_requested ? 'cancelled' : 'succeeded'
    i.result = {
      content: [{ type: 'text', text: this.summary(root.agent_name, top) }],
      delegate: { run_id: root.run_id, root_id: root.root_id, branch_ids: root.branch_ids },
    }
    if (
      JSON.stringify(i.result).length > 65536 ||
      Buffer.byteLength(JSON.stringify(i)) > 240 * 1024
    ) {
      ;(i.result as any).content = [
        {
          type: 'text',
          text: 'The sub-runs finished, but their summary exceeds the node transport limit. Read the recorded branch results and history; do not repeat the work to retrieve its output.',
        },
      ]
    }
    this.host.save(i)
  }
  private summary(agent: string, branches: Branch[]) {
    if (branches.length === 1) {
      const b = branches[0]!
      return b.state === 'done'
        ? b.result || '(the sub-agent returned nothing)'
        : `${agent} did not finish: ${b.error || b.state}`
    }
    const done = branches.filter((b) => b.state === 'done'),
      errors = branches.filter((b) => b.state === 'error' || b.state === 'outcome_unknown'),
      aborted = branches.filter((b) => b.state === 'aborted')
    const lines = [`## ${agent}: ${done.length}/${branches.length} succeeded`]
    if (aborted.length) lines.push(`${aborted.length} aborted`)
    if (done.length) {
      lines.push('\n### Completed:')
      for (const b of done)
        lines.push(
          `- **${b.item.length > 80 ? b.item.slice(0, 80) + '...' : b.item}**: ${(b.result ?? '').length > 200 ? b.result!.slice(0, 200) + '...' : (b.result ?? '')}`
        )
    }
    if (errors.length) {
      lines.push('\n### Failed:')
      for (const b of errors)
        lines.push(
          `- **${b.item.length > 80 ? b.item.slice(0, 80) + '...' : b.item}**: ${b.error || 'Unknown error'}`
        )
    }
    return lines.join('\n')
  }
}
