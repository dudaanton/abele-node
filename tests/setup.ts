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
const tailscale = join(dir, 'tailscale.mjs')
cpSync(new URL('./fixtures/tailscale.mjs', import.meta.url), tailscale)
chmodSync(tailscale, 0o700)
process.env.ABELE_TAILSCALE_PATH = tailscale
// Never let automated tests resolve gateway/auth through the real pi SDK host.
process.env.ABELE_PI_HOST = new URL('./fixtures/pi-host.mjs', import.meta.url).pathname
afterAll(() => rmSync(dir, { recursive: true, force: true }))
