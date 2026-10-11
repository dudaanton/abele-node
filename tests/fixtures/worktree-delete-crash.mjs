import { writeFileSync } from 'node:fs'
import { NodeCore } from '../../packages/node-core/dist/index.js'
const [state, worktree, requestFile, point] = process.argv.slice(2)
const core = new NodeCore(state)
await core.resources.ready
const actor = core.authority.authenticate(process.env.FIXTURE_OWNER_TOKEN)
const observed = await core.request(actor, 'repository.v1.observe', { worktree_id: worktree })
const params = {
  worktree_id: worktree,
  expected_head: observed.revision.head,
  expected_observation_id: observed.revision.observation_id,
}
writeFileSync(requestFile, JSON.stringify(params))
const kill = () => {
  process.kill(process.pid, 'SIGKILL')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
if (point === 'before-effect') {
  const run = core.resources.git.run.bind(core.resources.git)
  core.resources.git.run = (...args) => {
    if (args[1].kind === 'worktree.remove') kill()
    return run(...args)
  }
} else if (point === 'after-evidence') {
  const run = core.resources.git.run.bind(core.resources.git)
  core.resources.git.run = (...args) => {
    if (args[1].kind === 'worktree.remove') {
      const lifecycle = args[4]
      args[4] = {
        ...lifecycle,
        started: (evidence) => {
          lifecycle.started(evidence)
          kill()
        },
      }
    }
    return run(...args)
  }
} else core.resources.repository.deleteFault = kill
await core.request(actor, 'repository.v1.worktree.delete', params, 'crash-delete')
throw new Error('hard-kill fixture unexpectedly returned')
