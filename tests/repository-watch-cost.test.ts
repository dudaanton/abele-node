import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { WatchService } from '../packages/node-core/src/watch-service.js'

// Missing hints, but real disk, Git, timers and publication.
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: () => Object.assign(new EventEmitter(), { close() {} }),
}))
const fixtures: { dir: string; core?: NodeCore }[] = []
afterEach(async () => {
  for (const { dir, core } of fixtures.splice(0)) {
    if (core) {
      await core.resources.stop()
      core.close()
    }
    rmSync(dir, { recursive: true, force: true })
  }
}, 60000)
const gitPath = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : '/usr/bin/git'
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
it('bounds idle polling with 50k visible files, 50k ignored files and three leases', async () => {
  const dir = mkdtempSync(resolve('.scratch/watch-cost-'))
  const fixture: { dir: string; core?: NodeCore } = { dir }
  fixtures.push(fixture)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const result = spawnSync(gitPath, args, { cwd: repo, encoding: 'utf8' })
    if (result.status) throw new Error(result.stderr)
  }
  git('init', '-b', 'trunk')
  const commands = [
    'blob\nmark :1\ndata 6\nplain\n',
    'commit refs/heads/trunk\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 8\nfixture\n',
    'M 100644 inline .gitignore\ndata 14\nnode_modules/\n',
  ]
  for (let i = 0; i < 50000; i++)
    commands.push(`M 100644 :1 src/d${Math.floor(i / 100)}/f${i}.txt\n`)
  commands.push('\ndone\n')
  const imported = spawnSync(gitPath, ['fast-import', '--quiet'], {
    cwd: repo,
    input: commands.join(''),
    encoding: 'utf8',
  })
  if (imported.status) throw new Error(imported.stderr)
  git('checkout', 'HEAD', '--', '.')
  for (let i = 0; i < 500; i++) {
    const folder = join(repo, 'node_modules', `package-${i}`)
    mkdirSync(folder, { recursive: true })
    for (let j = 0; j < 100; j++) writeFileSync(join(folder, `${j}.js`), 'ignored\n')
  }
  const core = (fixture.core = new NodeCore(join(dir, 'state')))
  // This lost-hint benchmark deliberately uses the fake fs.watch above, not OS handles.
  Object.defineProperty(core.resources, 'watchers', {
    value: new WatchService({ platform: 'linux' }),
  })
  Object.defineProperty(core.resources.git, 'executable', { value: gitPath })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: object) =>
    (await core.request(actor, method, params, `cost-${++op}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  for (let i = 0; i < 2; i++)
    await request('repository.v1.watch', { worktree_id, changes: null, explicit_renewal: true })
  const other = core.authority.authenticate(core.createToken('other').token)
  await core.request(
    other,
    'repository.v1.watch',
    {
      worktree_id,
      changes: null,
      explicit_renewal: true,
    },
    'other-watch'
  )
  await settle(1000)
  const revision = (await request('repository.v1.observe', { worktree_id })).revision
  await request('repository.v1.blob', { worktree_id, revision, path: 'src/d499/f49999.txt' })
  const repository = core.resources.repository as any
  const original = repository.changeBaseline.bind(repository)
  const costs: number[] = []
  const baseline = vi
    .spyOn(repository, 'changeBaseline')
    .mockImplementation(async (...args: any[]) => {
      const start = performance.now()
      const result = await original(...args)
      costs.push(performance.now() - start)
      return result
    })
  const probeCosts: number[] = []
  const probe = repository.watchNeedsReconcile.bind(repository)
  vi.spyOn(repository, 'watchNeedsReconcile').mockImplementation((...args: any[]) => {
    const started = performance.now()
    const result = probe(...args)
    probeCosts.push(performance.now() - started)
    return result
  })
  await settle(1600)
  console.info('50k watch idle ms', { baseline: costs, probe: probeCosts })
  expect(baseline).not.toHaveBeenCalled()
  expect(probeCosts.length).toBeGreaterThanOrEqual(2)
  expect(probeCosts.length).toBeLessThanOrEqual(4)
  const before = core.head('catalog'),
    started = performance.now()
  writeFileSync(join(repo, 'src/d499/f49999.txt'), 'edit!\n')
  const deliveries = () =>
    core
      .read('catalog', before)
      .filter(
        (event) =>
          event.type === 'repository.changed' &&
          (event.data as any).entries?.some((row: any) => row.entry?.path === 'src/d499/f49999.txt')
      )
  while (deliveries().length < 2 && performance.now() - started < 1500) await settle(10)
  console.info('50k open-file delivery ms', performance.now() - started)
  expect(deliveries()).toHaveLength(2)
  expect(new Set(deliveries().map((event) => JSON.stringify(event.actor))).size).toBe(2)
  expect(performance.now() - started).toBeLessThan(1000)
}, 180000)
