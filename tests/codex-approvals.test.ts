import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { CodexApprovalBridge } from '../packages/provider-codex/src/approval.js'
import { CodexEventMapper } from '../packages/provider-codex/src/mapper.js'

function setup(answer: any = { choice: 'allow', delivered: () => true }) {
  const workspace = mkdtempSync(resolve('.scratch/codex-approval-')),
    asks: any[] = []
  const mapper = new CodexEventMapper('run', () => {})
  mapper.bind('thread')
  mapper.accepted('turn')
  mapper.notification({
    method: 'item/started',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      item: {
        id: 'item',
        type: 'commandExecution',
        command: 'printf harmless',
        cwd: workspace,
        status: 'inProgress',
      },
    },
  })
  const bridge = new CodexApprovalBridge({
    generation: 'generation',
    workspace,
    mapper,
    ask: async (action) => {
      asks.push(action)
      return typeof answer === 'function' ? answer(action) : answer
    },
    cancel: async () => {},
  })
  const request = (id: number, extra: any = {}) => ({
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'item',
      kind: 'command',
      environmentId: null,
      command: 'printf harmless',
      cwd: workspace,
      ...extra,
    },
  })
  return {
    workspace,
    asks,
    mapper,
    bridge,
    request,
    close: () => rmSync(workspace, { recursive: true, force: true }),
  }
}
it('dispatches only consumed single-action decisions, with generation and exact request evidence', async () => {
  let consumed = 0
  const s = setup({
    choice: 'allow',
    delivered: () => {
      consumed++
      return true
    },
  })
  try {
    expect(await s.bridge.handle(s.request(1), new AbortController().signal)).toEqual({
      decision: 'accept',
    })
    expect(consumed).toBe(1)
    expect(s.asks[0].input).toMatchObject({
      generation: 'generation',
      request_id: 1,
      thread_id: 'thread',
      turn_id: 'turn',
      item_id: 'item',
    })
    expect(await s.bridge.handle(s.request(1), new AbortController().signal)).toEqual({
      decision: 'decline',
    })
    expect(consumed).toBe(1)
    expect(await s.bridge.handle(s.request(2), new AbortController().signal)).toEqual({
      decision: 'accept',
    })
    expect(s.asks).toHaveLength(2)
  } finally {
    s.close()
  }
})
it.each([
  { threadId: 'stale' },
  { turnId: 'stale' },
  { command: 'changed' },
  { cwd: '/' },
  { additionalPermissions: {} },
  { proposedExecpolicyAmendment: ['printf'] },
  { proposedNetworkPolicyAmendments: [] },
  { environmentId: 'remote' },
  { kind: 'stdin' },
  { availableDecisions: ['acceptForSession'] },
])('denies inconsistent or expanding evidence %j without opening a prompt', async (extra) => {
  const s = setup()
  try {
    expect(await s.bridge.handle(s.request(1, extra), new AbortController().signal)).toEqual({
      decision: 'decline',
    })
    expect(s.asks).toHaveLength(0)
  } finally {
    s.close()
  }
})
it.each(['expired', 'revoked', 'crash-window', 'aborted'])(
  'does not grant on %s at consumption',
  async (mode) => {
    const abort = new AbortController()
    const s = setup(async () => {
      if (mode === 'aborted') abort.abort()
      return {
        choice: mode === 'expired' ? 'deny' : 'allow',
        delivered: () => {
          if (mode === 'revoked' || mode === 'crash-window') throw new Error(mode)
          return true
        },
      }
    })
    try {
      expect(await s.bridge.handle(s.request(1), abort.signal)).toEqual({ decision: 'decline' })
    } finally {
      s.close()
    }
  }
)
it('aggregates bounded questions, retains descriptions/free text and cancels without defaults', async () => {
  const s = setup((action: any) => ({
    choice: 'allow',
    value: action.input.question_id === 'q1' ? 'One' : 'Other text',
    delivered: () => true,
  }))
  const request = {
    id: 8,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'question',
      questions: [
        {
          id: 'q1',
          header: 'Header',
          question: 'Choose',
          isOther: false,
          isSecret: false,
          options: [{ label: 'One', description: 'First description' }],
        },
        {
          id: 'q2',
          header: 'Header',
          question: 'Text',
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  }
  try {
    expect(await s.bridge.handle(request, new AbortController().signal)).toEqual({
      answers: { q1: { answers: ['One'] }, q2: { answers: ['Other text'] } },
    })
    expect(s.asks[0].input.options[0].description).toBe('First description')
    expect(s.asks[1].kind).toBe('input')
    const denied = setup({ choice: 'deny', delivered: () => true })
    try {
      await expect(denied.bridge.handle(request, new AbortController().signal)).rejects.toThrow(
        'cancelled'
      )
    } finally {
      denied.close()
    }
  } finally {
    s.close()
  }
})
