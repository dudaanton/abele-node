import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { CodexEventMapper } from '../packages/provider-codex/src/mapper.js'
import { CodexApprovalBridge } from '../packages/provider-codex/src/approval.js'
it('retains sanitized resumed thread metadata referring to a previous turn without treating it as new delivery', () => {
  const events: any[] = [],
    mapper = new CodexEventMapper('run', (e) => events.push(e))
  mapper.bind('recorded-thread')
  expect(() =>
    mapper.notification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'recorded-thread',
        turnId: 'previous-turn',
        tokenUsage: { secret: 'discarded' },
      },
    })
  ).not.toThrow()
  expect(events.map((e) => e.type)).toEqual(['codex.notification.unknown'])
  expect(JSON.stringify(events)).not.toContain('discarded')
  expect(mapper.turnId).toBeUndefined()
})
it('accepts the native local single-action offer without accepting its advertised rule amendment', async () => {
  const workspace = mkdtempSync(resolve('.scratch/codex-native-contract-'))
  const command = "/bin/zsh -c 'printf native-replay'",
    events: any[] = [],
    asks: any[] = []
  let consumed = 0
  try {
    const mapper = new CodexEventMapper('run', (e) => events.push(e))
    mapper.bind('thread')
    mapper.accepted('turn')
    mapper.notification({
      method: 'item/started',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'commandExecution',
          id: 'call-command',
          command,
          cwd: workspace,
          processId: null,
          status: 'inProgress',
        },
      },
    })
    const bridge = new CodexApprovalBridge({
      generation: 'gen',
      workspace,
      mapper,
      cancel: async () => {},
      ask: async (action) => {
        asks.push(action)
        return {
          choice: 'allow',
          delivered: () => {
            consumed++
            return true
          },
        }
      },
    })
    const reply = await bridge.handle(
      {
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: {
          kind: 'command',
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'call-command',
          environmentId: 'local',
          command,
          cwd: workspace,
          proposedExecpolicyAmendment: ['printf', 'native-replay'],
          availableDecisions: [
            'accept',
            {
              acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', 'native-replay'] },
            },
            'cancel',
          ],
        },
      },
      new AbortController().signal
    )
    expect(reply).toEqual({ decision: 'accept' })
    expect(consumed).toBe(1)
    expect(asks).toHaveLength(1)
    expect(JSON.stringify(reply)).not.toMatch(/ForSession|Amendment/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
