import { basename } from 'node:path'
import { z } from 'zod'
import { ChannelError } from '@abele/channel-protocol'
import { SessionSchema } from '@abele/node-protocol'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from './index.js'
import type { LiveSessions } from './live-sessions.js'

type Sender = { session_id: string; run_id: string; principal: string }
type From = { session_id: string; title: string }
const actor = { kind: 'node' } as const
/** Messages from other sessions that may wait in one session's queue at once. */
const QUEUED_LIMIT = 16
const LISTED = 100
/** How much a permission mode lets run without asking; unknown modes count as the most. */
const PERMISSIVENESS: Record<string, number> = {
  plan: 0,
  dontAsk: 0,
  manual: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
}
const permissiveness = (mode: string) => PERMISSIVENESS[mode] ?? 5

/** Whether a message from one session may run in another now, or the code that refuses it. Both
 * when it is sent and when it is delivered: either session's mode may have changed in between. */
export function messageRefusal(live: LiveSessions, from: string, to: string) {
  try {
    if (!live.effective(to).messaging) return 'messaging_off'
    // A session cannot start work that asks fewer questions than it would have to itself: the
    // receiver counts as the most it may run without asking, the sender as the least.
    if (
      Math.max(...live.modes(to).map(permissiveness)) >
      Math.min(...live.modes(from).map(permissiveness))
    )
      return 'target_more_permissive'
    return null
  } catch {
    return 'not_found'
  }
}

/** What the receiving process reads: the message, and who wrote it. */
export function messageContent(body: { text: string; from_session?: From }) {
  if (!body.from_session) return body.text
  const { session_id, title } = body.from_session
  return (
    `<session-message from_session_id=${JSON.stringify(session_id)} from_title=${JSON.stringify(title)}>\n` +
    // The text cannot close the block early or open one in another sender's name.
    `${body.text.replace(/<(\/?)session-message/gi, '<$1session_message')}\n</session-message>\n` +
    'This message comes from another of the owner’s sessions on this node, not from the owner. ' +
    'To answer it, use node_session_send with that session id.'
  )
}

/** Owner sessions on one node list each other and write to each other through the node, so both
 * journals show the message and the receiver need not be running. Sender identity is the node's,
 * never the model's. */
export class SessionMessageTools implements DebuggerToolBridge {
  private closed = false
  private results = new WeakSet<object>()
  readonly tools: DebuggerToolBridge['tools']
  constructor(
    private core: NodeCore,
    private live: LiveSessions,
    private sender: Sender,
    private active: () => boolean,
    private inner?: DebuggerToolBridge
  ) {
    this.tools = [
      {
        name: 'node_sessions',
        description:
          'List the owner’s other chats on this node: title, project, whether a process runs, whether it waits for the owner. Without `all`, only chats with a running process.',
        inputSchema: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'Also chats without a running process.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'node_session_send',
        description:
          'Write a message to another of the owner’s chats on this node. It arrives there as a new message marked as coming from this chat, and starts that chat if it is not running. The answer is not returned here: the other chat replies by sending a message back.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', maxLength: 128 },
            text: { type: 'string', minLength: 1, maxLength: 32768 },
          },
          required: ['session_id', 'text'],
          additionalProperties: false,
        },
      },
      ...(inner?.tools ?? []),
    ]
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    if (name !== 'node_sessions' && name !== 'node_session_send') {
      if (!this.inner) throw new ChannelError('unsupported_method')
      return this.inner.call(name, args, signal)
    }
    if (this.closed || !this.active()) throw new ChannelError('stale_run')
    if (signal?.aborted) throw new ChannelError('cancelled')
    // The installation that runs this process must still be allowed to.
    this.core.checkExecution(this.sender.principal, this.sender.session_id)
    const result = !this.live.effective(this.sender.session_id).messaging
      ? { code: 'messaging_off' }
      : name === 'node_sessions'
        ? this.list(args)
        : this.send(args)
    this.results.add(result)
    return result
  }
  publish(args: unknown, result: any) {
    if (result && typeof result === 'object' && this.results.has(result)) return result
    if (!this.inner) throw new ChannelError('invalid_result')
    return this.inner.publish(args, result)
  }
  close() {
    this.closed = true
    this.inner?.close()
  }
  private owned() {
    return (
      this.core.db
        .prepare(
          'SELECT body FROM sessions WHERE session_id NOT IN (SELECT session_id FROM deleted_sessions) AND session_id NOT IN (SELECT session_id FROM delegations)'
        )
        .all() as { body: string }[]
    )
      .map((row) => SessionSchema.parse(JSON.parse(row.body)))
      .filter((s) => this.live.handles(s.session_id))
  }
  private project(session_id: string) {
    try {
      const bound = this.core.resources.targets.bound(session_id)
      const workspace = this.core.session(session_id).workspace_id
      const project_id =
        bound?.project_id ??
        (workspace ? this.core.resources.workspaces.get(workspace).project_id : undefined)
      return project_id ? basename(this.core.resources.projects.get(project_id).root_path) : null
    } catch {
      return null
    }
  }
  private list(args: unknown) {
    const parsed = z
      .object({ all: z.boolean().optional() })
      .strict()
      .safeParse(args ?? {})
    if (!parsed.success) return { code: 'invalid_params' }
    const sessions = this.owned()
      .map((s) => ({ session: s, state: this.live.state(s.session_id) }))
      .filter(
        ({ session, state }) =>
          parsed.data.all ||
          state.process !== 'none' ||
          session.session_id === this.sender.session_id
      )
      .sort((a, b) => b.session.created_at.localeCompare(a.session.created_at))
      .slice(0, LISTED)
      .map(({ session, state }) => ({
        session_id: session.session_id,
        title: session.title,
        project: this.project(session.session_id),
        process: state.process,
        waiting_for_owner: this.core.prompts(session.session_id).some((p) => p.state === 'pending'),
        messaging: state.settings.messaging,
        self: session.session_id === this.sender.session_id,
      }))
    return { sessions }
  }
  private send(args: unknown) {
    const parsed = z
      .object({ session_id: z.string().min(1).max(128), text: z.string().min(1).max(32768) })
      .strict()
      .safeParse(args)
    if (!parsed.success) return { code: 'invalid_params' }
    const { session_id, text } = parsed.data
    if (session_id === this.sender.session_id) return { code: 'invalid_target' }
    const target = this.owned().find((s) => s.session_id === session_id)
    if (!target) return { code: 'not_found' }
    const refusal = messageRefusal(this.live, this.sender.session_id, session_id)
    if (refusal) return { code: refusal }
    const from: From = {
      session_id: this.sender.session_id,
      title: this.core.session(this.sender.session_id).title,
    }
    try {
      return this.core.transaction(() => {
        // Two sessions answering each other forever stop at a full queue, not at the owner's limits.
        const waiting = (
          this.core.db
            .prepare(
              "SELECT COUNT(*) AS n FROM inputs WHERE session_id=? AND state IN ('accepted','queued') AND json_extract(body,'$.from_session') IS NOT NULL"
            )
            .get(session_id) as { n: number }
        ).n
        if (waiting >= QUEUED_LIMIT) return { code: 'target_busy' }
        this.core.checkExecution(this.sender.principal, session_id)
        const accepted = this.core.acceptInput(
          this.core.authority.forInstallation(this.sender.principal),
          {
            session_id,
            text,
            observed_seq: this.core.head(session_id),
            script: [{ kind: 'echo' }],
            from_session: from,
          }
        ) as { input_id: string }
        this.core.append(this.sender.session_id, 'session.message.sent', actor, {
          input_id: accepted.input_id,
          to_session_id: session_id,
          to_title: target.title,
          text,
        })
        return {
          input_id: accepted.input_id,
          session_id,
          title: target.title,
          state: 'queued',
          process: this.live.state(session_id).process,
        }
      })
    } catch (error) {
      return { code: error instanceof ChannelError ? error.code : 'send_failed' }
    }
  }
}
