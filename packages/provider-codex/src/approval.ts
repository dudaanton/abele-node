import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Answer, ProviderAction } from '@abele/provider-contract'
import { CodexEventMapper, opaqueId } from './mapper.js'
import { ServerRequestRejected, type RpcMessage } from './rpc.js'
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v)
const boundedText = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
function confinedPath(workspace: string, path: string) {
  const absolute = resolve(workspace, path),
    local = relative(workspace, absolute)
  if (
    local.startsWith('..' + sep) ||
    local === '..' ||
    isAbsolute(local) ||
    local.split(sep).some((p) => ['.git', '.codex'].includes(p))
  )
    return false
  let ancestor = absolute
  for (;;) {
    try {
      lstatSync(ancestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === workspace) return false
      ancestor = dirname(ancestor)
      continue
    }
    // An existing dangling link is not a missing directory.
    try {
      const physical = realpathSync(ancestor),
        from = relative(workspace, physical)
      return from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from)
    } catch {
      return false
    }
  }
}
interface BridgeOptions {
  generation: string
  workspace: string
  mapper: CodexEventMapper
  ask(action: ProviderAction, signal: AbortSignal): Promise<Answer>
  cancel(): Promise<void>
}
export class CodexApprovalBridge {
  private claimed = new Set<string>()
  constructor(private options: BridgeOptions) {}
  private evidence(msg: RpcMessage) {
    const p = msg.params
    if (
      msg.id === undefined ||
      p?.threadId !== this.options.mapper.threadId ||
      p?.turnId !== this.options.mapper.turnId ||
      !opaqueId(p?.itemId)
    )
      return undefined
    return {
      generation: this.options.generation,
      request_id: msg.id,
      thread_id: p.threadId,
      turn_id: p.turnId,
      item_id: p.itemId,
    }
  }
  async handle(msg: RpcMessage, signal: AbortSignal): Promise<unknown> {
    const evidence = this.evidence(msg),
      p = msg.params
    const command = msg.method === 'item/commandExecution/requestApproval',
      patch = msg.method === 'item/fileChange/requestApproval'
    if (!command && !patch && msg.method !== 'item/tool/requestUserInput')
      throw new ServerRequestRejected(-32601, 'codex_request_unsupported')
    const key = `${typeof msg.id}:${msg.id}`
    if (!evidence || signal.aborted || this.claimed.has(key) || this.claimed.size >= 4096) {
      if (command || patch) return { decision: 'decline' }
      throw new ServerRequestRejected(-32000, 'codex_interaction_cancelled')
    }
    this.claimed.add(key)
    if (!command && !patch) return this.questions(p, evidence, signal)
    const decline = { decision: 'decline' }
    const item = this.options.mapper.item(p.itemId)
    if (
      !item ||
      item.status !== 'inProgress' ||
      p.grantRoot != null ||
      p.additionalPermissions != null ||
      (p.proposedExecpolicyAmendment != null &&
        (!Array.isArray(p.proposedExecpolicyAmendment) ||
          p.proposedExecpolicyAmendment.length > 32 ||
          p.proposedExecpolicyAmendment.some((v: unknown) => !boundedText(v, 4096)) ||
          !Array.isArray(p.availableDecisions) ||
          !p.availableDecisions.includes('accept'))) ||
      p.proposedNetworkPolicyAmendments != null ||
      (p.availableDecisions != null &&
        (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept')))
    )
      return decline
    if (
      command &&
      (p.kind !== 'command' ||
        (p.environmentId !== null && p.environmentId !== 'local') ||
        item.type !== 'commandExecution' ||
        p.command !== item.command ||
        p.cwd !== item.cwd ||
        !boundedText(p.command, 32768) ||
        !boundedText(p.cwd, 4096) ||
        !confinedPath(this.options.workspace, p.cwd))
    )
      return decline
    if (patch && (item.type !== 'fileChange' || !this.validChanges(item.changes))) return decline
    const before = canonical(item)
    const input = {
      ...evidence,
      ...(command ? { command: p.command, cwd: p.cwd } : { changes: item.changes }),
      ...(boundedText(p.reason, 4096) ? { reason: p.reason } : {}),
    }
    const digest = createHash('sha256').update(canonical(input)).digest('hex')
    try {
      const answer = await this.options.ask(
        {
          kind: 'permission',
          tool_use_id: digest,
          tool_name: command ? 'codex.command' : 'codex.patch',
          input: structuredClone(input),
        },
        signal
      )
      if (
        signal.aborted ||
        before !== canonical(this.options.mapper.item(p.itemId)) ||
        (command ? !confinedPath(this.options.workspace, p.cwd) : !this.validChanges(item.changes))
      )
        return decline
      const consumed = answer.delivered() === true
      return { decision: consumed && answer.choice === 'allow' ? 'accept' : 'decline' }
    } catch {
      return decline
    }
  }
  private validChanges(changes: any) {
    return (
      Array.isArray(changes) &&
      changes.length > 0 &&
      changes.length <= 128 &&
      changes.every(
        (c) =>
          boundedText(c.path, 4096) &&
          confinedPath(this.options.workspace, c.path) &&
          boundedText(c.diff, 65536) &&
          ['add', 'delete', 'update'].includes(c.kind?.type) &&
          (c.kind.type !== 'update' ||
            c.kind.move_path == null ||
            (boundedText(c.kind.move_path, 4096) &&
              confinedPath(this.options.workspace, c.kind.move_path)))
      )
    )
  }
  private async questions(p: any, evidence: Record<string, unknown>, signal: AbortSignal) {
    const cancel = async (): Promise<never> => {
      await this.options.cancel()
      throw new ServerRequestRejected(-32000, 'codex_interaction_cancelled')
    }
    const questions = p.questions
    if (
      !Array.isArray(questions) ||
      !questions.length ||
      questions.length > 16 ||
      new Set(questions.map((q) => q.id)).size !== questions.length
    )
      return cancel()
    if (
      questions.some(
        (q) =>
          !opaqueId(q.id) ||
          !boundedText(q.header, 1024) ||
          !boundedText(q.question, 8192) ||
          q.isSecret !== false ||
          typeof q.isOther !== 'boolean' ||
          (q.options != null &&
            (!Array.isArray(q.options) ||
              q.options.length > 32 ||
              q.options.some(
                (o: any) => !boundedText(o.label, 256) || !boundedText(o.description, 4096)
              ) ||
              new Set(q.options.map((o: any) => o.label)).size !== q.options.length))
      )
    )
      return cancel()
    const answers: Record<string, { answers: string[] }> = Object.create(null),
      claims: Answer[] = []
    try {
      for (const q of questions) {
        const input = {
          ...evidence,
          question_id: q.id,
          question: q.question,
          options: q.options ?? [],
          is_other: q.isOther,
        }
        const digest = createHash('sha256').update(canonical(input)).digest('hex')
        const options = q.options?.map((o: any) => o.label) ?? []
        const answer = await this.options.ask(
          {
            kind: q.isOther || !options.length ? 'input' : 'select',
            title: `${q.header}: ${q.question}`,
            options,
            tool_use_id: digest,
            tool_name: 'codex.question',
            input,
          },
          signal
        )
        if (
          signal.aborted ||
          answer.choice !== 'allow' ||
          !boundedText(answer.value, 32768) ||
          (!q.isOther && options.length && !options.includes(answer.value))
        )
          return cancel()
        answers[q.id] = { answers: [answer.value!] }
        claims.push(answer)
      }
      if (signal.aborted) return cancel()
      // Consume every durable answer immediately before the aggregate response. A
      // failure after any consumption is never replayed on a new process.
      for (const claim of claims) if (claim.delivered() !== true) return cancel()
      return { answers }
    } catch (error) {
      if (error instanceof ServerRequestRejected) throw error
      return cancel()
    }
  }
}
