import { createHash, randomUUID } from 'node:crypto'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  ObsidianToolsMethodSchemas,
  PromptSchema,
  type ObsidianConfiguration,
  type ObsidianToolsSnapshot,
  QuestionnaireQuestionsSchema,
  type Prompt,
} from '@abele/node-protocol'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from './index.js'
import { ObsidianDelegateHost } from './obsidian-delegate-host.js'

type State =
  | 'awaiting_client'
  | 'preparing'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
  | 'denied'
type Executor = { installation_id: string; client_id: string }
export interface Invocation {
  invocation_id: string
  session_id: string
  run_id: string
  call_id: string
  installation_id: string
  vault_id: string
  agent_id: string
  revision: string
  tool_name: string
  arguments: unknown
  state: State
  executor: Executor | null
  preview?: Record<string, unknown>
  prompt_id?: string
  result?: unknown
  cancel_requested?: boolean
  created_at: number
  prepared_bypass?: boolean
  prepared_needs_approval?: boolean
  hosted?: 'questions' | 'delegate'
  questionnaire_prompt_id?: string
}
type Client = Executor & {
  vault_id: string
  platform: string
  revisions: Record<string, string>
  signal: AbortSignal
}
const terminal = (state: State) =>
  ['succeeded', 'failed', 'outcome_unknown', 'cancelled', 'denied'].includes(state)
const bounded = <T>(result: T): T => {
  if (Buffer.byteLength(JSON.stringify(result)) > 240 * 1024)
    throw new ChannelError('result_too_large')
  return result
}
const stable = (value: any): string =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? '[' + value.map(stable).join(',') + ']'
      : '{' +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
          .join(',') +
        '}'
    : JSON.stringify(value)

/** SQLite is the dispatch authority. Poll is advisory; only a successful first claim executes. */
export class ObsidianTools {
  private readonly delegateHost: ObsidianDelegateHost
  private clients = new Map<string, Client>()
  private listeners = new Set<() => void>()
  private bindings = new Set<AbortController>()
  private detachingRuns = new Set<string>()
  private closing = false
  constructor(private core: NodeCore) {
    core.db
      .exec(`CREATE TABLE IF NOT EXISTS obsidian_tool_config(session_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obsidian_tool_revisions(session_id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(session_id,revision));
      INSERT OR IGNORE INTO obsidian_tool_revisions SELECT session_id,json_extract(body,'$.revision') FROM obsidian_tool_config;
      CREATE TABLE IF NOT EXISTS obsidian_tool_invocations(invocation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(session_id,run_id,call_id));`)
    this.delegateHost = new ObsidianDelegateHost(core, {
      config: (id) => this.config(id),
      save: (i) => this.save(i),
    })
  }
  private key(e: Executor) {
    return JSON.stringify([e.installation_id, e.client_id])
  }
  private config(session: string): ObsidianConfiguration {
    const row = this.core.db
      .prepare('SELECT body FROM obsidian_tool_config WHERE session_id=?')
      .get(session)
    if (!row) throw new ChannelError('obsidian_not_configured')
    return JSON.parse(String(row.body))
  }
  configured(session: string) {
    return !!this.core.db
      .prepare('SELECT 1 FROM obsidian_tool_config WHERE session_id=?')
      .get(session)
  }
  /** Snapshot inheritance runs in delegation.create's transaction, before input admission. */
  inheritInTransaction(
    parent: string,
    child: string,
    actor: AuthorityContext,
    supplied?: ObsidianToolsSnapshot
  ) {
    const row = this.core.db
      .prepare('SELECT body FROM obsidian_tool_config WHERE session_id=?')
      .get(parent)
    if (!row && !supplied) return
    const parentConfiguration: ObsidianConfiguration | undefined = row
      ? JSON.parse(String(row.body))
      : undefined
    if (parentConfiguration && supplied) {
      const { session_id: _session, ...snapshot } = parentConfiguration
      if (stable(snapshot) !== stable(supplied)) throw new ChannelError('stale_revision')
    }
    const configuration: ObsidianConfiguration = {
      ...(parentConfiguration ?? supplied!),
      session_id: child,
    }
    this.core.db
      .prepare('INSERT INTO obsidian_tool_revisions VALUES(?,?)')
      .run(child, configuration.revision)
    this.core.db
      .prepare('INSERT INTO obsidian_tool_config VALUES(?,?)')
      .run(child, JSON.stringify(configuration))
    this.core.append(
      child,
      'obsidian.tools.configured',
      { kind: 'installation', installation_id: actor.installation_id },
      configuration
    )
  }
  private all(): Invocation[] {
    return this.core.db
      .prepare('SELECT body FROM obsidian_tool_invocations ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.body)))
  }
  private get(id: string): Invocation {
    const row = this.core.db
      .prepare('SELECT body FROM obsidian_tool_invocations WHERE invocation_id=?')
      .get(id)
    if (!row) throw new ChannelError('not_found')
    return JSON.parse(String(row.body))
  }
  private save(i: Invocation) {
    this.core.db
      .prepare(
        'INSERT INTO obsidian_tool_invocations VALUES(?,?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET body=excluded.body'
      )
      .run(i.invocation_id, i.session_id, i.run_id, i.call_id, JSON.stringify(i))
    this.core.append(i.session_id, 'obsidian.tools.updated', { kind: 'node' }, i)
    // Read the committed row after the surrounding transaction has returned.
    // A failed COMMIT must never deliver a successful tool result.
    queueMicrotask(() => {
      for (const listener of this.listeners) listener()
    })
    return i
  }
  private policy(i: Invocation, revision: string) {
    const c = this.config(i.session_id)
    if (
      c.vault_id !== i.vault_id ||
      c.agent_id !== i.agent_id ||
      c.revision !== revision ||
      i.revision !== revision
    )
      throw new ChannelError('stale_revision')
    const tool = c.tools.find((t) => t.name === i.tool_name)
    if (!tool || tool.mode === 'off') throw new ChannelError('tool_disabled')
    return tool
  }
  private bypass(i: Invocation) {
    return this.core.claude?.live.effective(i.session_id).permission_mode === 'bypassPermissions'
  }
  private sync(i: Invocation) {
    if (i.state === 'awaiting_approval' && i.prompt_id) {
      const prompt = this.core.db
        .prepare('SELECT body FROM prompts WHERE prompt_id=?')
        .get(i.prompt_id)
      const p = prompt && PromptSchema.parse(JSON.parse(String(prompt.body)))
      if (p && p.state !== 'pending') {
        i.state = p.state === 'resolved' && p.choice === 'allow' ? 'ready' : 'denied'
        if (!p.delivered) {
          this.core.db
            .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
            .run(JSON.stringify({ ...p, delivered: true }), p.prompt_id)
          this.core.append(
            i.session_id,
            'prompt.delivered',
            { kind: 'node' },
            { prompt_id: p.prompt_id, run_id: p.run_id, choice: p.choice }
          )
        }
        this.save(i)
      }
    }
    return i
  }
  private cancel(i: Invocation, installation: string) {
    if (!terminal(i.state)) {
      i.cancel_requested = true
      if (i.hosted === 'delegate') this.delegateHost.cancel(i)
      if (
        i.state !== 'executing' ||
        i.hosted === 'questions' ||
        (i.tool_name === 'delegate' && !i.hosted)
      )
        i.state = 'cancelled'
      if (i.questionnaire_prompt_id) {
        i.result = { content: [{ type: 'text', text: 'User aborted the questionnaire.' }] }
        // The answer hook reads the committed invocation row in this transaction.
        this.save(i)
        const questionnaire = this.core.prompt(i.questionnaire_prompt_id)
        if (questionnaire.state === 'pending')
          this.core.resolvePrompt(questionnaire, 'invalidated', 'deny', installation)
      }
      if (i.prompt_id) {
        const prompt = this.core.prompt(i.prompt_id)
        if (prompt.state === 'pending')
          this.core.resolvePrompt(prompt, 'invalidated', 'deny', installation)
      }
      this.save(i)
    }
    return i
  }
  validateQuestionnaireAnswer(prompt: Prompt, answers: Prompt['answers']) {
    if (!answers || !prompt.questions || answers.length !== prompt.questions.length)
      throw new ChannelError('invalid_params')
    for (const [index, question] of prompt.questions.entries()) {
      const answer = answers[index]!
      const type = question.type ?? (question.options.length ? 'single' : 'input')
      if ((type === 'multi') !== Array.isArray(answer)) throw new ChannelError('invalid_params')
      const values = Array.isArray(answer) ? answer : [answer]
      if (
        new Set(values).size !== values.length ||
        values.some(
          (v) =>
            !v.trim() ||
            (question.allow_custom === false && type !== 'input' && !question.options.includes(v))
        )
      )
        throw new ChannelError('invalid_params')
    }
  }
  questionnaireAnsweredInTransaction(prompt: Prompt) {
    if (prompt.kind !== 'questionnaire') return
    const id = prompt.input?.invocation_id
    if (typeof id !== 'string') throw new ChannelError('invalid_params')
    const i = this.get(id)
    if (i.questionnaire_prompt_id !== prompt.prompt_id) throw new ChannelError('stale_revision')
    if (!terminal(i.state)) {
      const answered = prompt.state === 'resolved' && prompt.choice === 'allow'
      i.state = 'succeeded'
      i.result = {
        ...(answered ? { answers: prompt.answers } : {}),
        content: [
          {
            type: 'text',
            text: answered
              ? prompt
                  .questions!.map(
                    (q, index) =>
                      `Q: ${q.question}\nA: ${Array.isArray(prompt.answers![index]) ? (prompt.answers![index] as string[]).join(', ') : prompt.answers![index]}`
                  )
                  .join('\n\n')
              : 'User aborted the questionnaire.',
          },
        ],
      }
      this.save(i)
    }
    this.core.db
      .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
      .run(JSON.stringify({ ...prompt, delivered: true }), prompt.prompt_id)
    this.core.append(
      i.session_id,
      'prompt.delivered',
      { kind: 'node' },
      { prompt_id: prompt.prompt_id, run_id: prompt.run_id, choice: prompt.choice }
    )
    this.core.append(
      'catalog',
      'obsidian.tools.questionnaire',
      { kind: 'node' },
      { ...prompt, delivered: true }
    )
  }
  private openQuestions(i: Invocation) {
    if (i.questionnaire_prompt_id) return this.core.prompt(i.questionnaire_prompt_id)
    if (i.tool_name !== 'questions' || i.state !== 'executing' || i.cancel_requested)
      throw new ChannelError('operation_conflict')
    this.core.checkExecution(i.installation_id, i.session_id)
    this.policy(i, i.revision)
    const parsed = QuestionnaireQuestionsSchema.safeParse((i.arguments as any)?.questions)
    if (!parsed.success) throw new ChannelError('invalid_params')
    i.hosted = 'questions'
    i.questionnaire_prompt_id = randomUUID()
    const input = { invocation_id: i.invocation_id, vault_id: i.vault_id }
    const prompt = PromptSchema.parse({
      kind: 'questionnaire',
      prompt_id: i.questionnaire_prompt_id,
      session_id: i.session_id,
      run_id: 'obsidian:' + i.invocation_id,
      revision: 1,
      action_digest: createHash('sha256')
        .update(stable({ ...input, questions: parsed.data }))
        .digest('hex'),
      expires_at: Number.MAX_SAFE_INTEGER,
      state: 'pending',
      choice: null,
      installation_id: null,
      delivered: false,
      tool_name: 'questions',
      questions: parsed.data,
      input,
    })
    this.core.db
      .prepare('INSERT INTO prompts VALUES(?,?,?,?)')
      .run(prompt.prompt_id, prompt.session_id, prompt.run_id, JSON.stringify(prompt))
    this.save(i)
    this.core.append(i.session_id, 'prompt.opened', { kind: 'node' }, prompt)
    this.core.append('catalog', 'obsidian.tools.questionnaire', { kind: 'node' }, prompt)
    return prompt
  }
  /** Called inside the existing session mutation's transaction. */
  cancelRunInTransaction(session: string, installation: string, run?: string) {
    for (const i of this.all())
      if (i.session_id === session && (!run || i.run_id === run)) this.cancel(i, installation)
  }
  invoke(
    actor: AuthorityContext,
    session: string,
    run: string,
    call: string,
    name: string,
    args: unknown
  ) {
    this.core.authority.check(actor, 'execute', session)
    this.core.session(session)
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      JSON.stringify(args).length > 65536
    )
      throw new ChannelError('invalid_params')
    const c = this.config(session)
    const tool = c.tools.find((t) => t.name === name)
    if (!tool || tool.mode === 'off') throw new ChannelError('tool_disabled')
    const prior = this.core.db
      .prepare(
        'SELECT body FROM obsidian_tool_invocations WHERE session_id=? AND run_id=? AND call_id=?'
      )
      .get(session, run, call)
    if (prior) {
      const i: Invocation = JSON.parse(String(prior.body))
      if (
        i.installation_id !== actor.installation_id ||
        i.tool_name !== name ||
        stable(i.arguments) !== stable(args)
      )
        throw new ChannelError('operation_conflict')
      return this.core.transaction(() => this.sync(i))
    }
    return this.core.transaction(() =>
      this.save({
        invocation_id: randomUUID(),
        session_id: session,
        run_id: run,
        call_id: call,
        installation_id: actor.installation_id,
        vault_id: c.vault_id,
        agent_id: c.agent_id,
        revision: c.revision,
        tool_name: name,
        arguments: args,
        state: 'awaiting_client',
        executor: null,
        created_at: Date.now(),
      })
    )
  }
  request(actor: AuthorityContext, method: string, raw: unknown, signal?: AbortSignal): unknown {
    this.core.authority.check(actor, 'execute')
    const schema = ObsidianToolsMethodSchemas[method as keyof typeof ObsidianToolsMethodSchemas]
    const parsed = schema?.safeParse(raw)
    if (!parsed?.success) throw new ChannelError('invalid_params')
    const p = parsed.data as any
    if (method.endsWith('.questions.pending')) {
      const prompts = this.all()
        .filter((i) => i.vault_id === p.vault_id && i.questionnaire_prompt_id)
        .map((i) => this.core.prompt(i.questionnaire_prompt_id!))
        .filter((p) => p.state === 'pending')
        .sort((a, b) => a.prompt_id.localeCompare(b.prompt_id))
        .filter((prompt) => !p.after_id || prompt.prompt_id > p.after_id)
        .slice(0, 128)
      const page: Prompt[] = []
      let bytes = 0
      for (const prompt of prompts) {
        const size = Buffer.byteLength(JSON.stringify(prompt))
        if (bytes + size > 200 * 1024) break
        page.push(prompt)
        bytes += size
      }
      return page
    }
    if (method.endsWith('.configuration')) {
      this.core.session(p.session_id)
      const configuration = this.config(p.session_id)
      return {
        configuration,
        clients: [...this.clients.values()]
          .filter((c) => !c.signal.aborted && c.vault_id === configuration.vault_id)
          .map(({ signal: _, ...client }) => client),
      }
    }
    if (method.endsWith('.configure')) {
      return this.core.transaction(() => {
        this.core.session(p.session_id)
        const { expected_revision, ...configuration } = p
        const old = this.core.db
          .prepare('SELECT body FROM obsidian_tool_config WHERE session_id=?')
          .get(p.session_id)
        if (old) {
          const previous = JSON.parse(String(old.body))
          if (previous.revision === p.revision) {
            if (stable(previous) !== stable(configuration))
              throw new ChannelError('revision_conflict')
            return previous
          }
          if (previous.revision !== expected_revision) throw new ChannelError('stale_revision')
        } else if (expected_revision !== undefined) {
          throw new ChannelError('stale_revision')
        }
        if (
          this.core.db
            .prepare('SELECT 1 FROM obsidian_tool_revisions WHERE session_id=? AND revision=?')
            .get(p.session_id, p.revision)
        )
          throw new ChannelError('revision_conflict')
        this.core.db
          .prepare('INSERT INTO obsidian_tool_revisions VALUES(?,?)')
          .run(p.session_id, p.revision)
        this.core.db
          .prepare(
            'INSERT INTO obsidian_tool_config VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET body=excluded.body'
          )
          .run(p.session_id, JSON.stringify(configuration))
        this.core.append(
          p.session_id,
          'obsidian.tools.configured',
          { kind: 'installation', installation_id: actor.installation_id },
          configuration
        )
        return configuration
      })
    }
    if (method.endsWith('.advertise')) {
      if (!signal || signal.aborted) throw new ChannelError('disconnected')
      const client: Client = { ...p, installation_id: actor.installation_id, signal }
      const key = this.key(client)
      const existing = this.clients.get(key)
      if (existing && !existing.signal.aborted && existing.signal !== signal)
        throw new ChannelError('client_connected')
      this.clients.set(key, client)
      return { advertised: true }
    }
    if (method.endsWith('.poll')) {
      const client = this.clients.get(
        this.key({ installation_id: actor.installation_id, client_id: p.client_id })
      )
      if (!client || client.signal.aborted) throw new ChannelError('disconnected')
      return this.core.transaction(() =>
        this.all()
          .flatMap((i) => {
            this.sync(i)
            if (terminal(i.state)) return []
            // Before execution, a disconnected preparer can be replaced. Its exact
            // preview approval is never transferred to a different executor.
            if (i.executor && i.state !== 'executing') {
              const selected = this.clients.get(this.key(i.executor))
              if (!selected || selected.signal.aborted || selected.vault_id !== i.vault_id) {
                if (i.prompt_id) {
                  const prompt = this.core.prompt(i.prompt_id)
                  if (prompt.state !== 'invalidated')
                    this.core.resolvePrompt(prompt, 'invalidated', 'deny', actor.installation_id)
                }
                delete i.prompt_id
                delete i.preview
                i.executor = null
                i.state = 'awaiting_client'
                this.save(i)
              }
            }
            if (!i.executor) {
              const eligible = [...this.clients.values()]
                .filter(
                  (c) =>
                    !c.signal.aborted &&
                    c.vault_id === i.vault_id &&
                    c.revisions[i.agent_id] === i.revision
                )
                .sort(
                  (a, b) =>
                    Number(b.platform === 'desktop') - Number(a.platform === 'desktop') ||
                    this.key(a).localeCompare(this.key(b))
                )
              const selected = eligible[0]
              if (!selected || this.key(selected) !== this.key(client)) return []
              i.executor = { installation_id: client.installation_id, client_id: client.client_id }
              i.state = 'preparing'
              this.save(i)
            }
            if (this.key(i.executor) !== this.key(client) || client.vault_id !== i.vault_id)
              return []
            return [
              {
                ...i,
                action: i.cancel_requested
                  ? 'cancel'
                  : i.hosted
                    ? 'hosted'
                    : i.state === 'executing'
                      ? 'reconcile'
                      : i.state === 'ready'
                        ? 'claim'
                        : i.state === 'awaiting_approval'
                          ? 'waiting_approval'
                          : 'prepare',
              },
            ]
          })
          .slice(0, 128)
      )
    }
    let admission: string | undefined
    try {
      return this.core.transaction(() => {
        const i = this.sync(this.get(p.invocation_id))
        this.core.authority.check(actor, 'execute', i.session_id)
        if (method === 'obsidian.tools.v1.get') return i
        if (method.endsWith('.delegate.get')) return bounded(this.delegateHost.get(i, p.run_id))
        if (method.endsWith('.delegate.branch'))
          return bounded(this.delegateHost.details(i, p.branch_id))
        if (method.endsWith('.delegate.history')) return bounded(this.delegateHost.history(i, p))
        if (method.endsWith('.cancel')) {
          return this.cancel(i, actor.installation_id)
        }
        const client = this.clients.get(
          this.key({ installation_id: actor.installation_id, client_id: p.client_id })
        )
        if (
          !i.executor ||
          this.key(i.executor) !==
            this.key({ installation_id: actor.installation_id, client_id: p.client_id }) ||
          !client ||
          client.signal.aborted ||
          client.vault_id !== i.vault_id
        )
          throw new ChannelError('wrong_executor')
        // Only the bound executor can fail an unadmitted delegate invocation.
        if (
          method.endsWith('.delegate.begin') &&
          i.tool_name === 'delegate' &&
          i.state === 'executing' &&
          !i.hosted
        )
          admission = i.invocation_id
        if (method.endsWith('.complete')) {
          if (i.revision !== p.revision) throw new ChannelError('stale_revision')
          if (i.state === p.state && stable(i.result) === stable(p.result)) return i
          if (i.hosted) throw new ChannelError('hosted_invocation')
          if (i.state !== 'executing') throw new ChannelError('operation_conflict')
          i.state = p.state
          i.result = p.result
          return this.save(i)
        }
        if (p.revision !== i.revision) throw new ChannelError('stale_revision')
        if (method.endsWith('.questions.open')) {
          if (!i.questionnaire_prompt_id && client.revisions[i.agent_id] !== p.revision)
            throw new ChannelError('stale_revision')
          return this.openQuestions(i)
        }
        if (method.includes('.delegate.')) {
          if (
            (method.endsWith('.begin') || method.endsWith('.claim')) &&
            i.state === 'executing' &&
            !i.cancel_requested
          ) {
            this.core.checkExecution(i.installation_id, i.session_id)
            if (client.revisions[i.agent_id] !== p.revision)
              throw new ChannelError('stale_revision')
            this.policy(i, p.revision)
          }
          if (method.endsWith('.begin')) return bounded(this.delegateHost.begin(i, p))
          if (method.endsWith('.claim')) return bounded(this.delegateHost.claim(i, p.branch_id))
          if (method.endsWith('.record')) return bounded(this.delegateHost.record(i, p))
        }
        this.core.session(i.session_id)
        if (client.revisions[i.agent_id] !== p.revision) throw new ChannelError('stale_revision')
        const tool = this.policy(i, p.revision)
        if (method.endsWith('.claim')) {
          if (i.state !== 'ready' || i.cancel_requested) return { execute: false, invocation: i }
          if (i.prepared_bypass && !this.bypass(i)) {
            i.state = 'preparing'
            this.save(i)
            return { execute: false, invocation: i }
          }
          i.state = 'executing'
          this.save(i)
          return { execute: true, invocation: i, bypass: this.bypass(i) }
        }
        if (method.endsWith('.prepare')) {
          if (i.state === 'awaiting_approval' || i.state === 'ready') {
            if (
              stable(i.preview) === stable(p.preview) &&
              i.prepared_bypass === this.bypass(i) &&
              i.prepared_needs_approval === p.needs_approval
            )
              return i
            if (i.prompt_id) {
              const prompt = this.core.prompt(i.prompt_id)
              if (prompt.state !== 'invalidated')
                this.core.resolvePrompt(prompt, 'invalidated', 'deny', actor.installation_id)
            }
            i.state = 'preparing'
            delete i.prompt_id
          }
          if (i.state !== 'preparing') return i
          i.preview = p.preview
          i.prepared_bypass = this.bypass(i)
          i.prepared_needs_approval = p.needs_approval
          if (!this.bypass(i) && (tool.mode === 'ask' || p.needs_approval)) {
            i.prompt_id = randomUUID()
            i.state = 'awaiting_approval'
            const input = {
              invocation_id: i.invocation_id,
              tool_name: i.tool_name,
              arguments: i.arguments,
              preview: i.preview,
              vault_id: i.vault_id,
              revision: i.revision,
            }
            const prompt = PromptSchema.parse({
              prompt_id: i.prompt_id,
              session_id: i.session_id,
              run_id: 'obsidian:' + i.invocation_id,
              revision: 1,
              action_digest: createHash('sha256').update(stable(input)).digest('hex'),
              expires_at: Number.MAX_SAFE_INTEGER,
              state: 'pending',
              choice: null,
              installation_id: null,
              delivered: false,
              tool_name: i.tool_name,
              input,
            })
            this.core.db
              .prepare('INSERT INTO prompts VALUES(?,?,?,?)')
              .run(prompt.prompt_id, prompt.session_id, prompt.run_id, JSON.stringify(prompt))
            this.core.append(i.session_id, 'prompt.opened', { kind: 'node' }, prompt)
          } else i.state = 'ready'
          return this.save(i)
        }
        throw new ChannelError('unsupported_method')
      })
    } catch (error) {
      // Roll back admission (including reservations) before persisting failure.
      if (admission)
        this.core.transaction(() => {
          const i = this.get(admission!)
          if (i.state !== 'executing' || i.hosted) return
          i.state = i.cancel_requested ? 'cancelled' : 'failed'
          i.result = {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Delegate admission failed: ${error instanceof Error ? error.message : 'unknown_error'}`,
              },
            ],
          }
          this.save(i)
        })
      throw error
    }
  }
  bridge(
    actor: AuthorityContext,
    session: string,
    run: string,
    active: () => boolean,
    inner?: DebuggerToolBridge
  ): DebuggerToolBridge {
    let closed = false
    const abort = new AbortController()
    this.bindings.add(abort)
    const results = new WeakMap<object, string>()
    let definitions: ObsidianConfiguration['tools'] = []
    try {
      definitions = this.config(session).tools.filter((t) => t.mode !== 'off')
    } catch (error) {
      if (!(error instanceof ChannelError) || error.code !== 'obsidian_not_configured') throw error
    }
    const names = new Set(definitions.map((t) => 'obsidian_' + t.name))
    const check = () => {
      if (closed || !active()) throw new ChannelError('stale_run')
      this.core.checkExecution(actor.installation_id, session)
    }
    return {
      tools: [
        ...(inner?.tools ?? []),
        ...definitions.map(({ name, description, inputSchema }) => ({
          name: 'obsidian_' + name,
          description,
          inputSchema,
        })),
      ],
      call: async (name, args, signal, callId) => {
        check()
        if (!names.has(name)) {
          if (!inner) throw new ChannelError('unsupported_method')
          return inner.call(name, args, signal)
        }
        const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
        if (combined.aborted) throw new ChannelError('cancelled')
        const invocation = this.invoke(
          actor,
          session,
          run,
          callId ?? randomUUID(),
          name.slice(9),
          args
        )
        return new Promise((resolve, reject) => {
          let timer: ReturnType<typeof setInterval> | undefined
          const cleanup = () => {
            this.listeners.delete(update)
            combined.removeEventListener('abort', cancel)
            if (timer) clearInterval(timer)
          }
          const update = () => {
            try {
              check()
              const i = this.core.transaction(() => this.sync(this.get(invocation.invocation_id)))
              if (terminal(i.state)) {
                cleanup()
                const result = {
                  invocation_id: i.invocation_id,
                  state: i.state,
                  result: i.result ?? null,
                  cancel_requested: i.cancel_requested ?? false,
                }
                results.set(result, i.invocation_id)
                resolve(result)
              }
            } catch (error) {
              cleanup()
              if (!this.closing && !this.detachingRuns.has(run))
                try {
                  this.request(actor, 'obsidian.tools.v1.cancel', {
                    invocation_id: invocation.invocation_id,
                  })
                } catch {
                  /* preserve original failure */
                }
              reject(error)
            }
          }
          const cancel = () => {
            cleanup()
            if (!this.closing && !this.detachingRuns.has(run))
              try {
                this.request(actor, 'obsidian.tools.v1.cancel', {
                  invocation_id: invocation.invocation_id,
                })
              } catch {
                /* authority may have been revoked */
              }
            reject(new ChannelError('cancelled'))
          }
          this.listeners.add(update)
          combined.addEventListener('abort', cancel, { once: true })
          // Prompt resolution is journaled separately; this timer never starts a provider turn.
          timer = setInterval(update, 250)
          update()
        })
      },
      publish: (args, result) => {
        check()
        const id = result && typeof result === 'object' ? results.get(result) : undefined
        if (id) {
          const i = this.get(id)
          this.policy(i, i.revision)
          return result
        }
        if (inner) return inner.publish(args, result)
        throw new ChannelError('invalid_result')
      },
      close: () => {
        closed = true
        abort.abort()
        this.bindings.delete(abort)
        inner?.close()
      },
    }
  }
  close() {
    this.closing = true
    for (const abort of this.bindings) abort.abort()
    this.bindings.clear()
    this.clients.clear()
    this.listeners.clear()
  }
  suspendRun(run: string) {
    this.detachingRuns.add(run)
  }
}
