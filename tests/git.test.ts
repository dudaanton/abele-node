import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GitRunner } from '../packages/node-core/src/git.js'

mkdirSync('.scratch', { recursive: true })
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function program(body: string) {
  const dir = mkdtempSync(resolve('.scratch/git-runner-'))
  dirs.push(dir)
  const executable = join(dir, 'git fixture')
  writeFileSync(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 })
  return { dir, executable }
}
it('bounds stdout/stderr and kills timed-out processes before resolving', async () => {
  const noisy = program("process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 60000)")
  await expect(
    new GitRunner(1000, 1024, noisy.executable).run(noisy.dir, { kind: 'status' })
  ).rejects.toThrow('output_limit')
  const hang = program('setTimeout(() => {}, 60000)')
  await expect(
    new GitRunner(30, 1024, hang.executable).run(hang.dir, { kind: 'status' })
  ).rejects.toThrow('git_timeout')
})
it('pins short submodule diffs and disables lazy fetch in every invocation', async () => {
  const fixture = program(
    'process.stdout.write(JSON.stringify({args:process.argv.slice(2),lazy:process.env.GIT_NO_LAZY_FETCH}))'
  )
  const bytes = await new GitRunner(1000, 4096, fixture.executable).run(fixture.dir, {
    kind: 'root',
  })
  const invoked = JSON.parse(bytes.toString()) as { args: string[]; lazy: string }
  expect(invoked.args).toContain('diff.submodule=short')
  expect(invoked.lazy).toBe('1')
})
it('serializes metadata within a repository but permits parallel independent repositories', async () => {
  const runner = new GitRunner()
  let release!: () => void
  const blocked = new Promise<void>((r) => {
    release = r
  })
  const order: string[] = []
  const first = runner.serialize('repo', async () => {
    order.push('first')
    await blocked
  })
  const second = runner.serialize('repo', async () => {
    order.push('second')
  })
  await runner.serialize('other', async () => {
    order.push('other')
  })
  expect(order).toEqual(['first', 'other'])
  release()
  await Promise.all([first, second])
  expect(order).toEqual(['first', 'other', 'second'])
})
