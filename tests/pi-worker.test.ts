import { it, expect } from 'vitest'
import {
  PiApprovalPolicy,
  PiExtensionUiBridge,
  PiSdkWorker,
  PiEventMapper,
} from '../packages/provider-pi/src/host.js'

const action = { tool_use_id: 'call', tool_name: 'bash', input: { command: 'printf safe' } }
it('fails closed on absent, aborted, duplicate, undelivered and changed tool approvals', async () => {
  let delivered = 0
  const controller = new AbortController()
  const policy = new PiApprovalPolicy(
    async () => ({
      choice: 'allow',
      delivered: () => {
        delivered++
        return true
      },
    }),
    controller.signal
  )
  expect(await policy.intercept(action)).toBeUndefined()
  expect(delivered).toBe(1)
  expect(await policy.intercept(action)).toMatchObject({ block: true })
  expect(
    await new PiApprovalPolicy(async () => {
      throw Error('offline')
    }, controller.signal).intercept(action)
  ).toMatchObject({ block: true })
  expect(
    await new PiApprovalPolicy(
      async () => ({ choice: 'allow', delivered: () => false }),
      controller.signal
    ).intercept(action)
  ).toMatchObject({ block: true })
  expect(
    await new PiApprovalPolicy(
      async () => ({ choice: 'allow', delivered: () => {} }),
      controller.signal
    ).intercept(action)
  ).toMatchObject({ block: true })
  const changed = structuredClone(action)
  expect(
    await new PiApprovalPolicy(async () => {
      changed.input.command = 'rm bad'
      return { choice: 'allow', delivered: () => true }
    }, controller.signal).intercept(changed)
  ).toMatchObject({ block: true })
  controller.abort()
  expect(
    await new PiApprovalPolicy(
      async () => ({ choice: 'allow', delivered: () => true }),
      controller.signal
    ).intercept(action)
  ).toMatchObject({ block: true })
})
it('requires a fresh grant when replacement reuses a native tool ID in a different native session', async () => {
  let grants = 0
  const policy = new PiApprovalPolicy(
    async () => ({
      choice: 'allow',
      delivered: () => {
        grants++
        return true
      },
    }),
    new AbortController().signal
  )
  expect(
    await policy.intercept({ ...action, native_session_id: '11111111-1111-4111-8111-111111111111' })
  ).toBeUndefined()
  expect(
    await policy.intercept({ ...action, native_session_id: '22222222-2222-4222-8222-222222222222' })
  ).toBeUndefined()
  expect(grants).toBe(2)
})
it('never grants a tool after its SDK context signal was aborted', async () => {
  const sessionSignal = new AbortController(),
    actionSignal = new AbortController()
  let deliveries = 0
  const policy = new PiApprovalPolicy(async () => {
    actionSignal.abort()
    return {
      choice: 'allow',
      delivered: () => {
        deliveries++
        return true
      },
    }
  }, sessionSignal.signal)
  expect(await policy.intercept(action, actionSignal.signal)).toMatchObject({ block: true })
  expect(deliveries).toBe(0)
})
it('bridges select/confirm/input/trust and reports custom UI as unsupported', async () => {
  const requests: any[] = [],
    events: any[] = []
  const ui = new PiExtensionUiBridge(
    async (a: any) => {
      requests.push(a)
      return { choice: 'allow', value: a.kind === 'select' ? 'B' : 'answer', delivered: () => true }
    },
    new AbortController().signal,
    (e: any) => events.push(e)
  )
  expect(await ui.context.select('Pick', ['A', 'B'])).toBe('B')
  expect(await ui.context.confirm('Confirm', 'Really?')).toBe(true)
  expect(await ui.context.input('Name', 'hint')).toBe('answer')
  expect(await ui.trust('/workspace')).toBe(true)
  expect(requests.map((a) => a.kind)).toEqual(['select', 'confirm', 'input', 'trust'])
  await expect(ui.context.custom(() => {})).rejects.toThrow(/unsupported/)
  expect(events.at(-1).type).toBe('pi.capability.error')
  const deny = new PiExtensionUiBridge(
    async () => ({ choice: 'deny', delivered: () => true }),
    new AbortController().signal,
    () => {}
  )
  expect(await deny.context.confirm('Confirm')).toBe(false)
  expect(await deny.context.input('Name')).toBeUndefined()
})
it('normalizes parallel tools, retries and compaction without exporting auth/model objects', () => {
  const mapper = new PiEventMapper()
  const events = [
    { type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'one' } },
    { type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { path: 'two' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'b',
      toolName: 'read',
      result: { content: ['two'] },
      isError: false,
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      result: { content: ['one'] },
      isError: true,
    },
    { type: 'auto_retry_start', attempt: 1, errorMessage: 'Authorization Bearer SECRET' },
    {
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'summary', firstKeptEntryId: 'entry' },
    },
    {
      type: 'model_select',
      model: {
        provider: 'gateway',
        id: 'small',
        apiKey: 'SECRET',
        headers: { Authorization: 'SECRET' },
        baseUrl: 'SECRET',
      },
    },
    {
      type: 'future_child',
      parent_tool_use_id: 'a',
      child_id: 'child',
      payload: { apiKey: 'SECRET' },
      progress: 'done',
    },
  ].map((e) => mapper.map(e))
  expect(events.slice(0, 4).map((e) => e.data.tool_use_id)).toEqual(['a', 'b', 'b', 'a'])
  expect(JSON.stringify(events)).not.toContain('SECRET')
  expect(events.at(-1)?.data).toHaveProperty('parent_tool_use_id', 'a')
})
it('keeps native child IDs distinct from node-owned run/session correlation', () => {
  const event = new PiEventMapper().map({
    type: 'child_progress',
    run_id: 'native-run',
    session_id: 'native-child',
    parent_tool_use_id: 'parent',
    progress: 'working',
  })
  expect(event.data.run_id).toBeUndefined()
  expect(event.data.session_id).toBeUndefined()
  expect(event.data).toMatchObject({
    native_run_id: 'native-run',
    native_child_session_id: 'native-child',
    parent_tool_use_id: 'parent',
  })
})
it('rebinds the replacement runtime and waits past agent_end, retry and compaction to session idle', async () => {
  const events: any[] = [],
    subscriptions: Set<(e: any) => void>[] = [],
    bindings: any[] = []
  let finishIdle!: () => void
  const idle = new Promise<void>((r) => (finishIdle = r))
  const session = (id: string) => {
    const listeners = new Set<(e: any) => void>()
    subscriptions.push(listeners)
    return {
      sessionId: id,
      sessionFile: '/state/' + id + '.jsonl',
      subscribe: (fn: any) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      bindExtensions: async (b: any) => {
        bindings.push(b)
      },
      abort: async () => {},
      waitForIdle: () => idle,
      prompt: async (_text: string, options: any) => {
        options.preflightResult(true)
        for (const fn of listeners) fn({ type: 'agent_end' })
      },
      dispose: () => {},
    }
  }
  const old = session('old'),
    next = session('new')
  let rebind!: (s: any) => Promise<void>
  const runtime: any = { session: old, setRebindSession: (fn: any) => (rebind = fn) }
  const worker = new PiSdkWorker(
    runtime,
    (e: any) => events.push(e),
    () => ({})
  )
  await worker.bind()
  runtime.session = next
  await rebind(next)
  expect(subscriptions[0]!.size).toBe(0)
  expect(bindings).toHaveLength(2)
  let done = false
  const turn = worker.prompt('hello').then(() => {
    done = true
  })
  await new Promise((r) => setTimeout(r, 5))
  expect(done).toBe(false)
  for (const fn of subscriptions[1]!) {
    fn({ type: 'auto_retry_start', attempt: 1 })
    fn({ type: 'compaction_end', reason: 'overflow' })
    fn({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final' }],
        stopReason: 'stop',
      },
    })
    fn({ type: 'agent_settled' })
  }
  finishIdle()
  await turn
  expect(
    events.filter((e) => e.type === 'pi.session.bound').map((e) => e.data.native_session_id)
  ).toEqual(['old', 'new'])
  expect(done).toBe(true)
  expect(events.find((e) => e.type === 'pi.message.final')?.data).toMatchObject({
    runtime_generation: 2,
    native_session_id: 'new',
  })
})
