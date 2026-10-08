import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const race = vi.hoisted(() => ({
  parent: '',
  outside: '',
  target: '',
  active: false,
  interleaved: false,
  freshIdentity: false,
  opened: false,
  reads: 0,
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const swap = () => {
    actual.renameSync(race.parent, race.parent + '-held')
    actual.symlinkSync(race.outside, race.parent)
  }
  const restore = () => {
    actual.unlinkSync(race.parent)
    actual.renameSync(race.parent + '-held', race.parent)
  }
  return {
    ...actual,
    // A same-user writer can interleave with each pathname operation and restore the parent.
    lstatSync: (path: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (
        !race.active ||
        path !== race.target ||
        !(race.interleaved || (race.freshIdentity && race.opened))
      )
        return actual.lstatSync(path, options)
      swap()
      try {
        return actual.lstatSync(path, options)
      } finally {
        restore()
      }
    },
    openSync: (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (!race.active || path !== race.target || race.freshIdentity)
        return actual.openSync(path, flags, mode)
      swap()
      try {
        return actual.openSync(path, flags, mode)
      } finally {
        restore()
      }
    },
    fstatSync: (fd: number) => {
      const stat = actual.fstatSync(fd)
      if (race.active && stat.isFile()) race.opened = true
      return stat
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      if (race.active) race.reads++
      return actual.readSync(...args)
    },
  }
})
let core: NodeCore | undefined,
  dir = ''
afterEach(async () => {
  race.active = false
  race.interleaved = false
  race.freshIdentity = false
  race.opened = false
  race.reads = 0
  if (core) {
    await core.resources.stop()
    core.close()
    core = undefined
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})
async function setup() {
  fs.mkdirSync('.scratch', { recursive: true })
  dir = fs.mkdtempSync(resolve('.scratch/pinned-'))
  const root = join(dir, 'workspace')
  fs.mkdirSync(root)
  race.parent = join(root, 'sub')
  race.outside = join(dir, 'outside')
  race.target = join(race.parent, 'sample')
  fs.mkdirSync(race.parent)
  fs.mkdirSync(race.outside)
  fs.writeFileSync(race.target, 'inside')
  fs.writeFileSync(join(race.outside, 'sample'), 'outside secret')
  core = new NodeCore(join(dir, 'state'))
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const project = (await core.request(
    actor,
    'project.register',
    { path: root, trust: 'untrusted' },
    'register'
  )) as { project_id: string }
  const workspace = (
    (await core.request(actor, 'workspace.list', { project_id: project.project_id })) as {
      workspace_id: string
    }[]
  )[0]!
  return () =>
    core!.request(actor, 'workspace.read', {
      workspace_id: workspace.workspace_id,
      path: 'sub/sample',
    })
}
it('rejects a parent swap detected between the path check and open', async () => {
  const read = await setup()
  race.active = true
  await expect(read()).rejects.toThrow('unsafe_path')
  expect(race.reads).toBe(0)
  expect(core!.db.prepare('SELECT count(*) AS n FROM workspace_contents').get()).toMatchObject({
    n: 0,
  })
})
it('compares the opened descriptor with fresh resolved-path metadata before reading bytes', async () => {
  const read = await setup()
  race.active = true
  race.freshIdentity = true
  await expect(read()).rejects.toThrow('unsafe_path')
  expect(race.reads).toBe(0)
  expect(core!.db.prepare('SELECT count(*) AS n FROM workspace_contents').get()).toMatchObject({
    n: 0,
  })
})
it.fails(
  'BUG: needs openat; out of scope, same-user local process — fully interleaved parent swap and restoration',
  async () => {
    const read = await setup()
    race.active = true
    race.interleaved = true
    await expect(read()).rejects.toThrow('unsafe_path')
    expect(core!.db.prepare('SELECT count(*) AS n FROM workspace_contents').get()).toMatchObject({
      n: 0,
    })
  }
)
