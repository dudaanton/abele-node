// Every automated daemon/doctor process uses a fake executable, including version/help checks.
import { afterAll } from 'vitest'
import { mkdtempSync, cpSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'abele-test-cli-'))
const executable = join(dir, 'claude.mjs')
cpSync(new URL('./fixtures/claude.mjs', import.meta.url), executable)
chmodSync(executable, 0o700)
process.env.ABELE_CLAUDE_PATH = executable
afterAll(() => rmSync(dir, { recursive: true, force: true }))
