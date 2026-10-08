// Generate a local-only, path-free B0 summary. All run evidence stays ignored in .scratch.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const load = async (name) => JSON.parse(await readFile(`.scratch/evidence/${name}`, 'utf8'))
const results = await load('real-results.json')
assert.equal(results.length, 8, 'all eight explicit real-adapter scenarios must pass first')
const transcript = await load('real-dap.json')
const snapshot = {
  measured: '2026-10-07',
  inferenceTurns: 0,
  scenarios: results.map((r) => {
    const messages = transcript.filter((t) => t.scenario === r.scenario)
    const breakpoint = r.verifiedBreakpoint ?? r.breakpoint
    assert.equal(breakpoint.verified, true)
    return {
      scenario: r.scenario,
      breakpoint: { verified: breakpoint.verified, line: breakpoint.line },
      stopped: r.inspection.stopped,
      sourceFile: r.inspection.top.source.path.split('/').at(-1),
      stoppedLine: r.inspection.top.line,
      variableNames: r.inspection.variables.map((v) => v.name),
      evaluate: r.inspection.result.result,
      steppedSourceFile: r.inspection.next.source.path.split('/').at(-1),
      steppedLine: r.inspection.next.line,
      getter: r.getter,
      exception: { reason: r.exception.reason, breakMode: r.exceptionInfo.breakMode },
      detachAlive: r.detachAlive,
      terminatedOwnedProcess: r.terminatedOwnedProcess,
      supportsTerminateRequest: r.capabilities.supportsTerminateRequest,
      reverseRequests: messages
        .filter((t) => t.direction === 'receive' && t.message.type === 'request')
        .map((t) => t.message.command),
      successfulCommands: [
        ...new Set(
          messages
            .filter(
              (t) => t.direction === 'receive' && t.message.type === 'response' && t.message.success
            )
            .map((t) => t.message.command)
        ),
      ],
    }
  }),
}
snapshot.rawEvidenceSha256 = {}
for (const name of ['real-dap.json', 'real-results.json']) {
  snapshot.rawEvidenceSha256[name] = createHash('sha256')
    .update(await readFile(`.scratch/evidence/${name}`))
    .digest('hex')
}
await mkdir('.scratch/evidence', { recursive: true })
await writeFile(
  '.scratch/evidence/debug-probe-evidence.json',
  `${JSON.stringify(snapshot, null, 2)}\n`
)
console.log('Wrote .scratch/evidence/debug-probe-evidence.json (local-only summary)')
