import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore } from '@abele/node-core'
import { PiProviderAdapter } from '@abele/provider-pi'
import { ProcessSupervisor, systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
import {
  processScenarioDeadline,
  waitForProcessCondition,
} from '../scripts/process-test-budget.mjs'
const until = (fn: () => boolean) => waitForProcessCondition(fn, 'durable admission evidence')
it.each(['healthy', 'evidence-save', 'absence-check', 'record-removal', 'release-journal'])(
  'real adapter plus node-core SQLite gates shell admission/release under %s',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-durable-')),
      repo = join(dir, 'repo'),
      stateDir = join(dir, 'state')
    mkdirSync(repo)
    const git = (...args: string[]) => {
      const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
    }
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'file'), 'original')
    git('add', '.')
    git('commit', '-m', 'fixture')
    let worker: ProcessIdentity | undefined,
      anchor: ProcessIdentity | undefined,
      workspacePath = '',
      releaseEntered = false,
      releaseCommitted = false,
      verificationRefused = false
    let faultArmed = mode === 'absence-check'
    const seen = new Map<number, ProcessIdentity>()
    const adapter = new PiProviderAdapter({
      stateDir,
      profile: 'isolated',
      deadlineMs: 10000,
      permissionTtlMs: 10000,
      processProbe: {
        identity: (pid) => systemProcessProbe.identity(pid),
        groupMembers: (leader) => {
          if (
            faultArmed &&
            leader.pid === anchor?.pid &&
            !systemProcessProbe.identity(leader.pid)
          ) {
            faultArmed = false
            verificationRefused = true
            // The daemon's independent absence check disagrees with the worker.
            return [leader]
          }
          return systemProcessProbe.groupMembers(leader)
        },
      },
    })
    const core = new NodeCore(stateDir, { pi: adapter }),
      actor = core.authority.authenticate(core.createToken('test').token)
    const request = (method: string, params: unknown) =>
      core.request(actor, method, params, randomUUID())
    const processes = () =>
      JSON.parse(
        String(core.db.prepare('SELECT processes FROM provider_runs').get()?.processes ?? '[]')
      ) as ProcessIdentity[]
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    const realStart = adapter.startTurn.bind(adapter)
    adapter.startTurn = async (turn, sink) => {
      run = await realStart(turn, {
        ...sink,
        processes: (evidence) => {
          worker ??= evidence.find((p) => p.pid === p.group)
          const claimed = evidence.find(
            (p) => p.pid === p.group && p.pid !== worker?.pid && !seen.has(p.pid)
          )
          for (const p of evidence) seen.set(p.pid, p)
          if (claimed) anchor = claimed
          sink.processes(evidence) // REAL core SQL transaction, not a callback double
          if (claimed) {
            expect(processes()).toContainEqual(claimed)
            expect(existsSync(join(workspacePath, 'pi-effect.txt'))).toBe(false)
          }
        },
        reaped: (leader) => {
          releaseEntered = true
          expect(systemProcessProbe.groupMembers(leader)).toEqual([])
          sink.reaped!(leader) // REAL removal plus journal transaction
          releaseCommitted = true
          expect(processes().some((p) => p.group === leader.group)).toBe(false)
        },
      })
      return run
    }
    try {
      const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
        project_id: string
      }
      const workspace = (await request('workspace.create', { project_id: project.project_id })) as {
        workspace_id: string
      }
      await core.resources.jobs.drain()
      workspacePath = core.resources.workspaces.get(workspace.workspace_id).path
      const session = request('session.create', {
        title: 'durability',
        provider: 'pi',
        workspace_id: workspace.workspace_id,
      }) as { session_id: string }
      if (mode === 'evidence-save')
        core.db.exec(
          `CREATE TEMP TRIGGER fail_evidence BEFORE UPDATE OF processes ON provider_runs WHEN json_array_length(OLD.processes)>0 AND EXISTS (SELECT 1 FROM json_each(NEW.processes) n WHERE json_extract(n.value,'$.pid')=json_extract(n.value,'$.group') AND NOT EXISTS (SELECT 1 FROM json_each(OLD.processes) o WHERE json_extract(o.value,'$.pid')=json_extract(n.value,'$.pid'))) BEGIN SELECT RAISE(ABORT,'injected_evidence_save'); END;`
        )
      if (mode === 'record-removal')
        core.db.exec(
          `CREATE TEMP TRIGGER fail_removal BEFORE UPDATE OF processes ON provider_runs WHEN json_array_length(NEW.processes)<json_array_length(OLD.processes) BEGIN SELECT RAISE(ABORT,'injected_group_removal'); END;`
        )
      if (mode === 'release-journal')
        core.db.exec(
          `CREATE TEMP TRIGGER fail_release_event BEFORE INSERT ON events WHEN json_extract(NEW.body,'$.type')='pi.process.group_reaped' BEGIN SELECT RAISE(ABORT,'injected_release_journal'); END;`
        )
      request('session.send', { session_id: session.session_id, text: 'durable', observed_seq: 0 })
      await core.execution.drain()
      await until(() => core.prompts(session.session_id).some((p) => p.state === 'pending'))
      const prompt = core.prompts(session.session_id).find((p) => p.state === 'pending')!
      request('prompt.answer', {
        session_id: session.session_id,
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        revision: prompt.revision,
        action_digest: prompt.action_digest,
        choice: 'allow',
      })
      const outcome = await run!.done
      expect(anchor).toBeTruthy()
      expect(existsSync(join(workspacePath, 'pi-effect.txt'))).toBe(mode !== 'evidence-save')
      // Reaching this marker requires a release ACK from the REAL adapter. It is
      // not written by a shell, probe, sink spy or the SQLite fault fixture.
      expect(existsSync(join(workspacePath, 'pi-release-ack.txt'))).toBe(mode === 'healthy')
      expect(releaseCommitted).toBe(mode === 'healthy')
      if (mode === 'healthy') {
        expect(outcome).toMatchObject({ result: { subtype: 'success' } })
        await until(() => !!core.db.prepare("SELECT 1 FROM inputs WHERE state='completed'").get())
        expect(
          core.read(session.session_id, 0).some((e) => e.type === 'pi.process.group_reaped')
        ).toBe(true)
      } else {
        expect(outcome.reason).toBeTruthy()
        expect(
          core.db.prepare("SELECT 1 FROM inputs WHERE state='completed'").get()
        ).toBeUndefined()
        expect(
          core.read(session.session_id, 0).some((e) => e.type === 'pi.fixture_release_ack')
        ).toBe(false)
        if (mode === 'evidence-save')
          expect(processes().some((p) => p.pid === anchor!.pid)).toBe(false)
        else expect(processes()).toContainEqual(anchor)
        if (mode === 'absence-check') {
          expect(verificationRefused).toBe(true)
          expect(releaseEntered).toBe(false)
        }
        if (mode === 'record-removal' || mode === 'release-journal')
          expect(releaseEntered).toBe(true)
        expect(
          core.read(session.session_id, 0).some((e) => e.type === 'pi.process.group_reaped')
        ).toBe(false)
      }
    } finally {
      faultArmed = false
      const storageFault = ['evidence-save', 'record-removal', 'release-journal'].includes(mode)
      // A storage-fenced exit notification deliberately settles cleanup as
      // unconfirmed even after physical reaping. Its in-flight automatic stop
      // may reject once; physical absence is verified independently below.
      if (storageFault)
        await run
          ?.interrupt()
          .catch((error) => expect(error.message).toBe('process_cleanup_unconfirmed'))
      else await run?.interrupt()
      await ProcessSupervisor.cleanup([...seen.values()], 100)
      if (storageFault) await expect(core.execution.stop()).rejects.toThrow(/storage_unavailable/)
      else await core.execution.stop()
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  processScenarioDeadline(4)
)
