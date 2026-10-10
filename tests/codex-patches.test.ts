import { it, expect } from 'vitest'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { CodexEventMapper } from '../packages/provider-codex/src/mapper.js'
import { CodexApprovalBridge } from '../packages/provider-codex/src/approval.js'

it.each(['grant-root', 'symlink', 'dangling', 'changed', 'good'])(
  'correlates complete patch proposals and denies %s escapes or stale evidence',
  async (mode) => {
    const workspace = mkdtempSync(resolve('.scratch/codex-patch-'))
    let asked = 0,
      consumed = 0
    try {
      symlinkSync(resolve('.scratch'), join(workspace, 'escape'))
      symlinkSync(join(workspace, '../missing-external-target'), join(workspace, 'dangling'))
      const mapper = new CodexEventMapper('run', () => {})
      mapper.bind('thread')
      mapper.accepted('turn')
      const changes = [
        {
          path: mode === 'symlink' ? 'escape/file' : mode === 'dangling' ? 'dangling/file' : 'file',
          kind: { type: 'add' },
          diff: '+expected',
        },
      ]
      mapper.notification({
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: { id: 'patch', type: 'fileChange', status: 'inProgress', changes },
        },
      })
      const bridge = new CodexApprovalBridge({
        generation: 'g',
        workspace,
        mapper,
        cancel: async () => {},
        ask: async (action) => {
          asked++
          expect(action.input.changes).toEqual(changes)
          if (mode === 'changed')
            mapper.notification({
              method: 'item/fileChange/patchUpdated',
              params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'patch',
                changes: [{ ...changes[0], diff: '+different' }],
              },
            })
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
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            itemId: 'patch',
            ...(mode === 'grant-root' ? { grantRoot: workspace } : {}),
          },
        },
        new AbortController().signal
      )
      expect(reply).toEqual({ decision: mode === 'good' ? 'accept' : 'decline' })
      expect(consumed).toBe(mode === 'good' ? 1 : 0)
      expect(asked).toBe(mode === 'good' || mode === 'changed' ? 1 : 0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
)
