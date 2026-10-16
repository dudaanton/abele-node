import { expect, afterEach } from 'vitest'
import { processIt as it } from './process-test.js'
import { spawnSync } from 'node:child_process'
import { setup, until, sleep, alive, cleanupLive } from './live-harness.js'

// A node restart or update leaves long-lived sessions running; the next node adopts them.
afterEach(cleanupLive)

it('keeps a running turn through a node restart and journals what it wrote meanwhile, once', async () => {
  const s = await setup()
  const id = await s.session()
  const paused = s.send(id, 'pause 700')
  await until(() => s.replies(id).includes('before-pause'))
  const run_id = s.input(paused).run_id
  const cli = s.invocations()[0]!.pid
  await s.restart(async () => {
    // Nobody reads the stream now; the CLI keeps working and finishes the turn.
    await sleep(900)
    expect(alive(cli)).toBe(true)
  })
  await until(() => s.input(paused).state === 'completed')
  expect(s.replies(id)).toEqual(['before-pause', 'after-pause'])
  expect(s.events(id, 'turn.started')).toHaveLength(1)
  const completed = s.events(id, 'turn.completed')
  expect(completed).toHaveLength(1)
  expect(completed[0]!.data).toMatchObject({ run_id, input_ids: [paused], outcome: 'success' })
  expect(s.events(id, 'run.interrupted')).toHaveLength(0)
  expect(
    s.events(id, 'session.process').map((e) => [e.data.state, e.data.reattached ?? false])
  ).toEqual([
    ['starting', false],
    ['running', false],
    ['running', true],
  ])
  // The same process takes the next message.
  const next = s.send(id, 'again')
  await until(() => s.input(next).state === 'completed')
  expect(s.input(next).run_id).toBe(run_id)
  expect(s.invocations()).toHaveLength(1)
  expect(s.request('session.state', { session_id: id })).toMatchObject({ process: 'idle', run_id })
})

it('adopts a turn that is still running and lets the owner write into it', async () => {
  const s = await setup()
  const id = await s.session()
  const slow = s.send(id, 'slow')
  await until(() => s.input(slow).state === 'delivered')
  await s.restart()
  expect(s.request('session.state', { session_id: id })).toMatchObject({ process: 'running' })
  expect(s.input(slow).state).toBe('delivered')
  const later = s.send(id, 'later')
  await until(() => s.input(later).state === 'completed')
  expect(s.input(slow).state).toBe('completed')
  expect(s.events(id, 'turn.completed').map((e) => e.data.input_ids)).toEqual([[slow, later]])
  expect(s.replies(id).at(-1)).toBe('INJECTED later')
  expect(s.invocations()).toHaveLength(1)
})

it('keeps a background task through a restart and its finish starts the next turn', async () => {
  const s = await setup()
  const id = await s.session()
  const bg = s.send(id, 'background 900 gamma')
  await until(() => s.input(bg).state === 'completed')
  await s.restart()
  expect(s.request('session.state', { session_id: id }).background_tasks).toEqual([
    { task_id: 'task-gamma', task_type: 'local_bash', description: 'Background gamma' },
  ])
  await until(() => s.events(id, 'turn.completed').length === 2)
  expect(s.events(id, 'turn.started')[1]!.data.trigger).toBe('task')
  expect(s.replies(id).at(-1)).toBe('BG-NOTIFIED gamma')
  expect(s.request('session.state', { session_id: id }).background_tasks).toEqual([])
  expect(s.invocations()).toHaveLength(1)
})

it('asks a permission question again when the node restarted while it was open', async () => {
  const s = await setup()
  const id = await s.session()
  const asked = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  await s.restart()
  await until(() => s.core.prompts(id).filter((p) => p.state === 'pending').length === 1)
  const prompt = s.core.prompts(id).find((p) => p.state === 'pending')!
  s.request('prompt.answer', {
    session_id: id,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    revision: 1,
    action_digest: prompt.action_digest,
    choice: 'allow',
  })
  await until(() => s.input(asked).state === 'completed')
  expect(s.replies(id).at(-1)).toBe('allowed')
})

it('shows a process that died while the node was down, and resumes it on the next message', async () => {
  const s = await setup({}, { retryMs: 50 })
  const id = await s.session()
  const slow = s.send(id, 'slow')
  await until(() => s.input(slow).state === 'delivered')
  const cli = s.invocations()[0]!.pid
  await s.restart(async () => {
    process.kill(cli, 'SIGKILL')
    await until(() => !alive(cli))
  })
  await until(() => s.input(slow).state === 'delivery_unknown')
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  const exited = s.events(id, 'session.process').at(-1)!.data
  expect(exited.state).toBe('exited')
  expect(s.events(id, 'turn.completed').at(-1)!.data.outcome).toBe('interrupted')
  const next = s.send(id, 'next')
  await until(() => s.input(next).state === 'completed')
  const args = s.invocations()[1]!.args
  expect(args[args.indexOf('--resume') + 1]).toBe('22222222-2222-4222-8222-222222222222')
})

it('reports a lost session when its whole process group is gone, and the next message resumes it', async () => {
  const s = await setup({}, { retryMs: 50 })
  const id = await s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const cli = s.invocations()[0]!.pid
  const group = Number(
    spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(cli)], { encoding: 'utf8' }).stdout.trim()
  )
  await s.restart(async () => {
    process.kill(-group, 'SIGKILL')
    await until(() => !alive(cli))
  })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(s.events(id, 'session.process').at(-1)!.data).toMatchObject({
    state: 'exited',
    reason: 'process_lost',
  })
  const next = s.send(id, 'next')
  await until(() => s.input(next).state === 'completed')
  expect(s.invocations()).toHaveLength(2)
})

it('ends a session left without a node once the detached wait is over', async () => {
  const s = await setup({ detachedMs: 300 })
  const id = await s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const cli = s.invocations()[0]!.pid
  await s.restart(async () => {
    await until(() => !alive(cli))
  })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(s.events(id, 'session.process').at(-1)!.data.state).toBe('exited')
})
