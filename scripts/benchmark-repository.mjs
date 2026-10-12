// Disposable fixtures only. Usage: node scripts/benchmark-repository.mjs [clone-source]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { NodeCore } from '../packages/node-core/dist/index.js'
mkdirSync('.scratch', { recursive: true })
const root = mkdtempSync(resolve('.scratch/repository-bench-'))
function git(cwd, ...args) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function bench(repo, label) {
  const core = new NodeCore(join(root, label + '-state'))
  const actor = core.authority.authenticate(core.createToken('benchmark').token)
  let id = 0
  const request = (method, params) => core.request(actor, method, params, 'bench-' + ++id)
  try {
    const project = await request('project.register', {
      path: realpathSync(repo),
      trust: 'untrusted',
    })
    const target = (await request('repository.v1.worktrees', { project_id: project.project_id }))
      .entries[0].worktree_id
    const tracked = git(repo, 'ls-files', '-z').split('\0').filter(Boolean)
    const small =
      label === 'real'
        ? tracked
            .filter((path) => path.includes('/'))
            .sort((a, b) => b.split('/').length - a.split('/').length)[0]
        : 'deep/nested/folder/f00000.txt'
    writeFileSync(join(repo, 'benchmark-small.txt'), 'needle small\n')
    writeFileSync(join(repo, 'benchmark-megabyte.txt'), 'x'.repeat(1024 * 1024 - 1) + '\n')
    const t = performance.now()
    const revision = (await request('repository.v1.observe', { worktree_id: target })).revision
    const params = { worktree_id: target, revision }
    const results = {
      label,
      tracked: tracked.length,
      observe_ms: +(performance.now() - t).toFixed(1),
    }
    const measure = async (name, method, extra = {}, complete = false) => {
      const samples = []
      for (let i = 0; i < 4; i++) {
        const start = performance.now()
        let response = await request(method, { ...params, ...extra })
        if (complete && method === 'repository.v1.blob' && response.content_id) {
          for (let offset = 0; offset < response.size; offset += 131072)
            await request('repository.v1.content', {
              worktree_id: target,
              content_id: response.content_id,
              offset,
              length: 131072,
            })
        }
        if (complete && method === 'repository.v1.search') {
          let pages = 1
          let matches = response.entries.length
          while (response.cursor) {
            response = await request(method, { ...params, ...extra, cursor: response.cursor })
            pages++
            matches += response.entries.length
          }
          results.search_coverage = {
            pages,
            matches,
            incomplete: response.incomplete,
            omissions: response.omissions,
          }
        }
        samples.push(+(performance.now() - start).toFixed(1))
      }
      results[name] = { cold_ms: samples[0], warm_ms: samples.slice(1) }
    }
    await measure('root', 'repository.v1.tree', { limit: 100 })
    await measure('deep', 'repository.v1.tree', {
      path: small.slice(0, small.lastIndexOf('/')) || '',
      limit: 100,
    })
    await measure('small', 'repository.v1.blob', { path: 'benchmark-small.txt' })
    await measure('megabyte', 'repository.v1.blob', { path: 'benchmark-megabyte.txt' })
    await measure('search', 'repository.v1.search', { query: 'needle small' })
    await measure('small_complete', 'repository.v1.blob', { path: 'benchmark-small.txt' }, true)
    await measure(
      'megabyte_complete',
      'repository.v1.blob',
      { path: 'benchmark-megabyte.txt' },
      true
    )
    await measure('search_complete', 'repository.v1.search', { query: 'needle small' }, true)
    console.log(JSON.stringify(results))
  } catch (e) {
    console.log(JSON.stringify({ label, error: String(e) }))
  } finally {
    await core.resources.stop()
    core.close()
  }
}
try {
  if (process.argv[2]) {
    const repo = join(root, 'real')
    git(root, 'clone', '--no-local', process.argv[2], repo)
    await bench(repo, 'real')
  }
  const repo = join(root, 'synthetic')
  mkdirSync(join(repo, 'deep/nested/folder'), { recursive: true })
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Benchmark')
  git(repo, 'config', 'user.email', 'benchmark@example.invalid')
  for (let i = 0; i < 10500; i++)
    writeFileSync(
      join(repo, 'deep/nested/folder', `f${String(i).padStart(5, '0')}.txt`),
      'sample\n'
    )
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  await bench(repo, 'synthetic')
} finally {
  rmSync(root, { recursive: true, force: true })
}
