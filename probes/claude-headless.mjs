// Manual, bounded capability probe. Raw output stays in /tmp, never in the repository.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const scenario = process.argv[2] ?? 'baseline'
const scenarios = [
  'baseline',
  'deny',
  'approval',
  'input',
  'child',
  'thinking',
  'resume',
  'continue',
  'interrupt',
  'mcp',
  'mcp-deny',
  'recover',
]
if (!scenarios.includes(scenario))
  throw new Error(`Scenario must be one of: ${scenarios.join(', ')}`)
const directory = ['resume', 'continue', 'recover'].includes(scenario)
  ? process.argv[3]
  : await mkdtemp('/tmp/abele-node-stage0-claude-')
if (
  !directory?.startsWith('/tmp/abele-node-stage0-claude-') &&
  !directory?.startsWith('/private/tmp/abele-node-stage0-claude-')
) {
  throw new Error("Continuation requires this probe's /tmp scratch directory")
}
const run = randomUUID()
const args = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  ...(scenario.startsWith('mcp') ? ['--disable-slash-commands'] : ['--safe-mode']),
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  scenario.startsWith('mcp')
    ? JSON.stringify({
        mcpServers: {
          approval: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL('./approval-mcp.mjs', import.meta.url)),
              ...(scenario === 'mcp-deny' ? ['deny'] : []),
            ],
          },
        },
      })
    : '{"mcpServers":{}}',
  '--model',
  'haiku',
  '--effort',
  'low',
  '--max-budget-usd',
  '0.35',
  '--system-prompt',
  'You are a tiny feasibility probe. Follow the prompt exactly, use only this scratch directory, and be concise. Do not read any other files or configuration.',
  '--tools',
  scenario === 'child' ? 'Agent,Read' : 'Bash,Read,Write',
  '--permission-mode',
  'manual',
]
const prompts = {
  baseline:
    'Use Bash to run pwd and ls in this directory. Then reply PROBE_OK. Do not use other tools.',
  deny: 'Use Bash to run exactly printf hello > hello.txt. Make one attempt only. If denied, reply DENIED. No other tools.',
  approval:
    'Use Bash to run exactly printf hello > hello.txt. Make one attempt only. Then reply DONE or DENIED. No other tools.',
  input: 'Use Bash to run sleep 3. Then reply FIRST_DONE.',
  child:
    'Use the Agent tool exactly once with subagent_type general-purpose. Ask the child to reply CHILD_OK, no tools. Then reply PARENT_OK.',
  thinking: 'Think briefly about why 17 times 19 is 323. Reply with just the number.',
  resume:
    'What was the exact PROBE marker in the previous assistant reply? No tools. Reply with only that marker.',
  continue:
    'What was the exact PROBE marker in the first assistant reply? No tools. Reply with only that marker.',
  interrupt: 'Use Bash to run sleep 20. Then reply INTERRUPT_DONE.',
  mcp: 'Use Bash to run exactly printf hello > hello.txt. Make one attempt only. Then reply DONE or DENIED. No other tools.',
  'mcp-deny':
    'Use Bash to run exactly printf hello > hello.txt. Make one attempt only. Then reply DONE or DENIED. No other tools.',
  recover:
    'The previous process was interrupted. What command did I ask you to run? Do not run it again or use tools. Reply with just the command.',
}
const streaming = ['approval', 'input'].includes(scenario)
if (streaming)
  args.push(
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    '--permission-prompts',
    'host'
  )
else args.push('--permission-prompts', scenario.startsWith('mcp') ? 'host' : 'none')
if (['baseline', 'input', 'interrupt'].includes(scenario))
  args.push('--allowedTools', 'Bash(pwd),Bash(ls),Bash(sleep *)')
if (scenario === 'child') args.push('--allowedTools', 'Agent', '--forward-subagent-text')
if (scenario.startsWith('mcp')) args.push('--permission-prompt-tool', 'mcp__approval__permission')
if (['resume', 'recover'].includes(scenario)) {
  const saved = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'))
  args.push('--resume', saved.id)
}
if (scenario === 'continue') args.push('--continue')
if (!streaming) args.push('--', prompts[scenario])
const started = Date.now()
const child = spawn('claude', args, {
  cwd: directory,
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
let stdout = '',
  stderr = '',
  pending = '',
  secondSent = false,
  interrupted = false
const records = [],
  timeline = []
const stamp = (entry) => timeline.push({ ms: Date.now() - started, ...entry })
const send = (record) => child.stdin.write(JSON.stringify(record) + '\n')
const user = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  session_id: '',
})
function stop() {
  // Snapshot all descendants before killing parents (tool shells may have their own groups).
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((s) => s.trim().split(/\s+/).map(Number))
  const descendants = (pid) =>
    rows.filter((row) => row[1] === pid).flatMap(([id]) => [...descendants(id), id])
  const pids = [...descendants(child.pid), child.pid]
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }, 1000)
}
const timeout = setTimeout(() => {
  stamp({ action: 'hard_timeout' })
  stop()
}, 90_000)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
child.stdout.on('data', (chunk) => {
  stdout += chunk
  pending += chunk
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    let record
    try {
      record = JSON.parse(line)
    } catch {
      stamp({ action: 'invalid_json' })
      continue
    }
    records.push(record)
    stamp({
      type: record.type,
      subtype: record.subtype,
      stream: record.event?.type,
      parent: record.parent_tool_use_id,
    })
    if (record.type === 'control_request') {
      stamp({ action: 'permission_request', request: record.request })
      // A single disposable file write only; answer tool IDs verbatim, never broad allow rules.
      const request = record.request
      const allow =
        scenario === 'approval' &&
        request?.subtype === 'can_use_tool' &&
        request.tool_name === 'Bash' &&
        request.input?.command === 'printf hello > hello.txt'
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: record.request_id,
          response: allow
            ? { behavior: 'allow', updatedInput: request.input }
            : { behavior: 'deny', message: 'Probe denies unexpected action' },
        },
      })
      stamp({ action: 'permission_answer', allow })
    }
    const toolStarted =
      record.type === 'assistant' &&
      record.message?.content?.some((block) => block.type === 'tool_use')
    if (scenario === 'input' && toolStarted && !secondSent) {
      secondSent = true
      setTimeout(() => {
        send(user('Reply SECOND_DONE. Do not use tools.'))
        stamp({ action: 'second_user_sent_during_tool' })
        child.stdin.end()
      }, 300)
    }
    if (scenario === 'interrupt' && toolStarted && !interrupted) {
      interrupted = true
      setTimeout(() => {
        stamp({ action: 'intentional_interrupt' })
        stop()
      }, 600)
    }
    if (scenario === 'approval' && record.type === 'result') child.stdin.end()
  }
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.on('error', (error) => {
  stderr += String(error)
})
if (streaming) send(user(prompts[scenario]))
else child.stdin.end()
const exit = await new Promise((resolve) =>
  child.on('close', (code, signal) => resolve({ code, signal }))
)
clearTimeout(timeout)
await writeFile(join(directory, `${scenario}-${run}.jsonl`), stdout)
await writeFile(join(directory, `${scenario}-${run}.stderr`), stderr)
const id = records.find((r) => r.session_id)?.session_id
if (id) await writeFile(join(directory, 'session.json'), JSON.stringify({ id }))
const summary = {
  scenario,
  directory,
  exit,
  types: [...new Set(records.map((r) => r.type))],
  systemSubtypes: [...new Set(records.filter((r) => r.type === 'system').map((r) => r.subtype))],
  model: records.find((r) => r.type === 'system' && r.subtype === 'init')?.model,
  blocks: [
    ...new Set(
      records
        .flatMap((r) => r.message?.content ?? [])
        .map((b) => b.type)
        .filter(Boolean)
    ),
  ],
  streamTypes: [...new Set(records.filter((r) => r.event).map((r) => r.event.type))],
  messages: records
    .filter((r) => r.type === 'assistant' || r.type === 'user')
    .map((r) => ({
      type: r.type,
      parent_tool_use_id: r.parent_tool_use_id,
      content: r.message?.content,
    })),
  results: records
    .filter((r) => r.type === 'result')
    .map((r) => ({
      subtype: r.subtype,
      result: r.result,
      permission_denials: r.permission_denials,
      total_cost_usd: r.total_cost_usd,
    })),
  timeline,
  transcript: id
    ? join(
        homedir(),
        '.claude',
        'projects',
        (await realpath(directory)).replace(/[^a-zA-Z0-9]/g, '-'),
        `${id}.jsonl`
      )
    : null,
  stderr,
}
await writeFile(
  join(directory, `${scenario}-${run}.summary.json`),
  JSON.stringify(summary, null, 2)
)
console.log(JSON.stringify(summary, null, 2))
