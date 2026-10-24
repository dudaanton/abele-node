import { expect, it } from 'vitest'
import { ChangeStreams, baselineOf } from '../packages/node-core/src/repository-changes.js'

const entry = {
  path: 'open.txt',
  name: 'open.txt',
  kind: 'file' as const,
  oid: 'a'.repeat(40),
  size: 6,
}
const beforeStamp = '1:2:6:100:100:33188'
const afterStamp = '1:2:6:200:200:33188'
const snapshot = (stamp: string, dirty = false) =>
  baselineOf(
    {
      byPath: new Map([[entry.path, entry]]),
      stamps: new Map([[entry.path, stamp]]),
      status: dirty ? [{ path: entry.path, index: ' ', worktree: 'M' }] : [],
      head: 'a'.repeat(40),
    },
    '.scratch/no-such-gitdir'
  )

it('publishes a same-size open-file edit before the full scan, then only its Git status', async () => {
  const streams = new ChangeStreams(() => 'stream')
  await streams.open('tree', async () => snapshot(beforeStamp))
  const fast = streams.refreshFiles('tree', [entry.path], () => ({ stamp: afterStamp, size: 6 }))
  const full = streams.advance('tree', async () => snapshot(afterStamp, true), 'change')
  expect(await fast).toEqual({
    stream_id: 'stream',
    revision: 1,
    body: { complete: true, entries: [{ change: 'modified', entry }], git: null },
  })
  expect(await full).toMatchObject({
    revision: 2,
    body: {
      complete: true,
      entries: [],
      git: {
        status: [{ path: entry.path, entry: { path: entry.path, index: ' ', worktree: 'M' } }],
      },
    },
  })
  expect(
    await streams.refreshFiles('tree', [entry.path], () => ({ stamp: afterStamp, size: 6 }))
  ).toBeNull()
})

it('leaves removals and over-limit file updates for the authoritative full scan', async () => {
  const streams = new ChangeStreams(() => 'stream')
  await streams.open('tree', async () => snapshot(beforeStamp))
  expect(await streams.refreshFiles('tree', [entry.path], () => null)).toBeNull()
  streams.limit = 0
  expect(
    await streams.refreshFiles('tree', [entry.path], () => ({ stamp: afterStamp, size: 6 }))
  ).toBeNull()
  streams.limit = 1
  expect(await streams.advance('tree', async () => snapshot(afterStamp), 'change')).toMatchObject({
    revision: 1,
    body: { complete: true, entries: [{ change: 'modified', entry }] },
  })
})
