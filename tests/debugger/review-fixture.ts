import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore, DebuggerAgentBinding, DebuggerRunBinding } from '@abele/node-core'
import { target } from './helpers.js'

export function agentFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'debug-review-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const owner = core.authority.authenticate(core.createToken('owner').token)
  const initial = core.debugger.create(target),
    id = initial.debug_session_id
  core.debugger.observe(id, initial.incarnation, { kind: 'lifecycle', lifecycle: 'active' })
  core.debugger.observe(id, initial.incarnation, {
    kind: 'stopped',
    thread_id: 1,
    all_threads_stopped: true,
    reason: 'pause',
    hit_breakpoint_ids: [],
  })
  const control = core.debuggerControl
  const grant = (extra = {}) =>
    control.createGrant(owner, {
      installation_id: owner.installation_id,
      run_id: 'run',
      task_id: 'task',
      conversation_id: target.conversation_id,
      workspace_id: target.workspace_id,
      target_id: target.target_id,
      debug_session_id: id,
      incarnation: initial.incarnation,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      actions: ['read', 'step'],
      mode: 'allow-all',
      ...extra,
    })
  const principal = (g: ReturnType<typeof grant>) => ({
    kind: 'agent' as const,
    authority: owner,
    grant_id: g.grant_id,
    run_id: 'run',
    task_id: g.task_id,
    conversation_id: target.conversation_id,
    workspace_id: target.workspace_id,
    target_id: g.target_id,
  })
  let active = true
  const run = () =>
    new DebuggerRunBinding(core, {
      authority: owner,
      run_id: 'run',
      conversation_id: target.conversation_id,
      workspace_id: target.workspace_id,
      active: () => active,
    })
  const args = () => ({
    debug_session_id: id,
    incarnation: initial.incarnation,
    expected_state_revision: core.debugger.snapshot(id).snapshot.state_revision,
    thread_id: 1,
    kind: 'over',
  })
  return {
    core,
    control,
    owner,
    id,
    initial,
    grant,
    principal,
    run,
    setActive: (value: boolean) => {
      active = value
    },
    args,
    binding: (g: ReturnType<typeof grant>) => new DebuggerAgentBinding(core, principal(g)),
    close: () => {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
export function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
