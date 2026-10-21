import { expect, it } from 'vitest'
import { CodexTools } from '../packages/provider-codex/src/tools.js'

it('registers dynamic tools and executes an exact current-turn call only once', async () => {
  let calls = 0
  const tools = new CodexTools(
    {
      tools: [{ name: 'obsidian_create', description: 'Create', inputSchema: { type: 'object' } }],
      async call() {
        calls++
        return { state: 'succeeded' }
      },
      publish: (_a, r) => r,
      close() {},
    },
    () => ({ thread: 'thread', turn: 'turn' })
  )
  expect(tools.definitions()).toEqual([
    {
      type: 'function',
      name: 'obsidian_create',
      description: 'Create',
      inputSchema: { type: 'object' },
    },
  ])
  const p = {
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    namespace: null,
    tool: 'obsidian_create',
    arguments: { text: 'note' },
  }
  const signal = new AbortController().signal
  expect((await tools.handle(p, signal)).success).toBe(true)
  expect(await tools.handle(p, signal)).toEqual(await tools.handle(p, signal))
  expect(calls).toBe(1)
  await expect(tools.handle({ ...p, arguments: { text: 'different' } }, signal)).rejects.toThrow(
    'tool_call_conflict'
  )
  await expect(tools.handle({ ...p, turnId: 'old' }, signal)).rejects.toThrow('stale_tool_call')
})

it('rejects unknown tools and never delivers results after cancellation', async () => {
  const controller = new AbortController()
  const tools = new CodexTools(
    {
      tools: [{ name: 'obsidian_create', description: 'Create', inputSchema: {} }],
      async call() {
        controller.abort()
        return { state: 'succeeded' }
      },
      publish: (_a, r) => r,
      close() {},
    },
    () => ({ thread: 'thread', turn: 'turn' })
  )
  const p = {
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    namespace: null,
    tool: 'obsidian_create',
    arguments: {},
  }
  await expect(tools.handle({ ...p, tool: 'unknown' }, controller.signal)).rejects.toThrow(
    'unsupported_tool'
  )
  await expect(tools.handle(p, controller.signal)).rejects.toThrow('cancelled')
})

it('returns a tool error for a rejected Obsidian action without failing the app-server transport', async () => {
  const tools = new CodexTools(
    {
      tools: [{ name: 'obsidian_create', description: 'Create', inputSchema: {} }],
      async call() {
        throw new Error('tool_disabled')
      },
      publish: (_a, r) => r,
      close() {},
    },
    () => ({ thread: 'thread', turn: 'turn' })
  )
  const p = {
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    namespace: null,
    tool: 'obsidian_create',
    arguments: {},
  }
  expect(await tools.handle(p, new AbortController().signal)).toMatchObject({ success: false })
})
