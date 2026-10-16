// A long-lived pi host double: no SDK, credentials or model call. It keeps the session between
// prompts the way the SDK does, takes steered messages at its next step, and records each launch.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
export async function createHost(config, ask, signal, emit) {
  const id = config.native_session_id ?? randomUUID()
  const file = config.native_session_file ?? join(config.sessionDir, id + '.jsonl')
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: 'session', id }) + '\n')
  appendFileSync(
    join(config.cwd, 'pi-live-invocations.jsonl'),
    JSON.stringify({
      pid: process.pid,
      resumed: config.native_session_file ?? null,
      model: config.model,
      live: config.live,
      tools: (config.debugger_tools ?? []).map((t) => t.name),
    }) + '\n'
  )
  let streaming = false,
    aborted = false,
    bypass = config.live?.permission_mode === 'bypassPermissions',
    model = config.model || 'tiny'
  const queue = []
  const wake = new Set()
  const notify = () => {
    for (const fn of wake) fn()
  }
  const reply = (text) =>
    emit({
      type: 'pi.message.final',
      data: {
        message_id: randomUUID(),
        runtime_generation: 1,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    })
  // Waits for the steered queue, an abort, or the time limit.
  const waitFor = async (ms) => {
    const until = Date.now() + ms
    while (!aborted && !queue.length && Date.now() < until)
      await new Promise((r) => {
        wake.add(r)
        setTimeout(r, 20)
      }).finally(() => wake.clear())
  }
  const take = () => {
    const text = queue.shift()
    emit({ type: 'pi.queue_update', data: { steering: [...queue], followUp: [] } })
    return text
  }
  emit({ type: 'pi.session.bound', data: { native_session_id: id, native_session_file: file } })
  return {
    async prompt(text) {
      streaming = true
      aborted = false
      emit({ type: 'pi.agent_start', data: {} })
      try {
        if (text === 'slow') {
          await waitFor(4000)
          if (queue.length) reply('INJECTED ' + take())
          else if (!aborted) reply('slow done')
        } else if (text.startsWith('pause ')) {
          reply('before-pause')
          await delay(Number(text.slice(6)))
          reply('after-pause')
        } else if (text === 'tool') {
          const answer = bypass
            ? { choice: 'allow', delivered: () => true }
            : await ask(
                { tool_use_id: randomUUID(), tool_name: 'bash', input: { command: 'true' } },
                signal
              )
          reply(answer.choice === 'allow' && answer.delivered() ? 'allowed' : 'denied')
        } else reply('reply:' + text)
        if (aborted) throw new Error('pi_aborted')
        return { subtype: 'success', is_error: false }
      } finally {
        streaming = false
      }
    },
    async steer(text) {
      queue.push(text)
      emit({ type: 'pi.queue_update', data: { steering: [...queue], followUp: [] } })
      notify()
    },
    streaming: () => streaming,
    clearQueue: () => void queue.splice(0),
    async compact(instructions) {
      emit({ type: 'pi.compaction_start', data: { reason: 'manual' } })
      await delay(20)
      const result = {
        summary: 'summary: ' + (instructions ?? ''),
        tokensBefore: 5000,
        estimatedTokensAfter: 300,
      }
      emit({
        type: 'pi.compaction_end',
        data: { reason: 'manual', result, aborted: false, willRetry: false },
      })
      return { tokens_before: 5000, summary: result.summary }
    },
    context: () => ({ tokens: 1200, contextWindow: 200000, percent: 0.6, model }),
    commands: () => [{ name: 'review', description: 'Review the change', source: 'prompt' }],
    async setModel(id) {
      model = id
    },
    setEffort() {},
    setPermissionMode(mode) {
      bypass = mode === 'bypassPermissions'
    },
    async abort() {
      aborted = true
      notify()
    },
    async dispose() {},
  }
}
