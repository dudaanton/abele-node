import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
async function setup(trust: 'trusted' | 'untrusted' = 'untrusted') {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/init-races-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'source'), 'original')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust, exact_root: true })
  const workspace_id = (await request('workspace.list', { project_id: project.project_id }))[0]
    .workspace_id
  return { dir, folder, core, actor, request, project, workspace_id }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('does not initialize or repin a directory replacing a stored plain registration', async () => {
  const s = await setup()
  renameSync(s.folder, s.folder + '-old')
  mkdirSync(s.folder)
  await expect(
    s.request('project.git_init', { project_id: s.project.project_id, initial_branch: 'trunk' })
  ).rejects.toThrow('stale_resource')
  expect(existsSync(join(s.folder, '.git'))).toBe(false)
  expect(
    (await s.request('project.get', { project_id: s.project.project_id })).repository_path
  ).toBeNull()
  await expect(s.request('workspace.files', { workspace_id: s.workspace_id })).rejects.toThrow(
    'stale_resource'
  )
})
it('preserves a concurrent trust revocation and permission policy instead of restoring the pre-init project snapshot', async () => {
  const s = await setup('trusted')
  await s.request('project.claude_permissions', {
    project_id: s.project.project_id,
    use_repository_permissions: true,
  })
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      const result = await original(cwd, command, check, deadline)
      if (command.kind === 'init')
        await s.request('project.trust', { project_id: s.project.project_id, trust: 'untrusted' })
      return result
    }
  )
  const initialized = await s.request('project.git_init', {
    project_id: s.project.project_id,
    initial_branch: 'trunk',
  })
  expect(initialized).toMatchObject({
    trust: 'untrusted',
    use_repository_claude_permissions: false,
    repository_path: s.folder,
  })
  expect(await s.request('project.get', { project_id: s.project.project_id })).toEqual(initialized)
  await expect(
    s.request('session.create', { provider: 'claude', workspace_id: s.workspace_id })
  ).rejects.toThrow('project_untrusted')
})
it('does not commit a git registration over a newly admitted execution lease', async () => {
  const s = await setup('trusted'),
    target = { kind: 'workspace', workspace_id: s.workspace_id }
  await s.request('project.execution', { project_id: s.project.project_id, target, enabled: true })
  const chat = await s.request('session.create', { provider: 'fake', target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
    script: [{ kind: 'hang' }],
  })
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      const result = await original(cwd, command, check, deadline)
      if (command.kind === 'init') s.core.tick()
      return result
    }
  )
  await expect(
    s.request('project.git_init', { project_id: s.project.project_id, initial_branch: 'trunk' })
  ).rejects.toThrow('resource_busy')
  expect(
    (await s.request('project.get', { project_id: s.project.project_id })).repository_path
  ).toBeNull()
})
it('does not resurrect an unregistered project after the initialization effect', async () => {
  const s = await setup(),
    original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      const result = await original(cwd, command, check, deadline)
      if (command.kind === 'init')
        await s.request('project.remove', { project_id: s.project.project_id })
      return result
    }
  )
  await expect(
    s.request('project.git_init', { project_id: s.project.project_id, initial_branch: 'trunk' })
  ).rejects.toThrow('not_found')
  await expect(s.request('project.get', { project_id: s.project.project_id })).rejects.toThrow(
    'not_found'
  )
})
it('keeps the original registration pinned through reinspection and the final initialization commit', async () => {
  const s = await setup(),
    original = s.core.resources.projects.inspect.bind(s.core.resources.projects)
  vi.spyOn(s.core.resources.projects, 'inspect').mockImplementation(async (...args) => {
    const inspected = await original(...args)
    renameSync(s.folder, s.folder + '-old')
    mkdirSync(s.folder)
    const result = spawnSync('/usr/bin/git', ['init', '-b', 'replacement'], {
      cwd: s.folder,
      encoding: 'utf8',
    })
    if (result.status) throw new Error(result.stderr)
    return inspected
  })
  await expect(
    s.request('project.git_init', { project_id: s.project.project_id, initial_branch: 'trunk' })
  ).rejects.toThrow('stale_resource')
  expect(
    (await s.request('project.get', { project_id: s.project.project_id })).repository_path
  ).toBeNull()
  await expect(s.request('workspace.files', { workspace_id: s.workspace_id })).rejects.toThrow(
    'stale_resource'
  )
})
