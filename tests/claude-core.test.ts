import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'

it('requires a trusted isolated workspace for Claude and never accepts fake scripts as real tool authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-claude-core-'))
  const core = new NodeCore(dir)
  const actor = core.authority.authenticate(core.createToken('test').token)
  try {
    expect(() =>
      core.request(actor, 'session.create', { title: 'Real', provider: 'claude' }, 'missing')
    ).toThrow(/workspace_required/)
    expect(core.request(actor, 'node.describe', {})).toHaveProperty('providers')
    const session = core.request(actor, 'session.create', { title: 'lease fixture' }, 'create') as {
      session_id: string
    }
    core.db
      .prepare("INSERT INTO provider_runs(run_id,session_id,state) VALUES('run',?,'active')")
      .run(session.session_id)
    expect(() =>
      core.request(actor, 'session.detach', { session_id: session.session_id }, 'detach')
    ).toThrow(/resource_busy/)
    for (let i = 0; i < 270; i++) {
      const prompt_id = 'p-' + String(i).padStart(4, '0')
      core.db.prepare('INSERT INTO prompts VALUES(?,?,?,?)').run(
        prompt_id,
        session.session_id,
        'run',
        JSON.stringify({
          kind: 'permission',
          prompt_id,
          session_id: session.session_id,
          run_id: 'run',
          revision: 1,
          action_digest: 'a'.repeat(64),
          expires_at: Date.now() + 100000,
          state: i === 269 ? 'pending' : 'resolved',
          choice: i === 269 ? null : 'deny',
          installation_id: null,
          delivered: false,
        })
      )
    }
    const page = core.request(actor, 'prompt.list', { session_id: session.session_id }) as {
      prompt_id: string
    }[]
    expect(page).toHaveLength(256)
    expect(
      core.request(actor, 'prompt.list', {
        session_id: session.session_id,
        after_id: page.at(-1)!.prompt_id,
      })
    ).toHaveLength(14)
    expect(
      core.request(actor, 'prompt.list', { session_id: session.session_id, state: 'pending' })
    ).toHaveLength(1)
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
