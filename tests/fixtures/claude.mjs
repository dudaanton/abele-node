#!/usr/bin/env node
// Deterministic CLI/stdio-MCP fixture, NOT evidence of installed Claude compatibility.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
if (process.argv.includes('--version')) {
  console.log('2.1.291 (Claude Code)')
  process.exit()
}
if (process.argv.includes('--help')) {
  console.log(
    '--include-partial-messages --forward-subagent-text --resume --setting-sources --max-budget-usd'
  )
  process.exit()
}
const emit = (r) => console.log(JSON.stringify(r))
let text = ''
for await (const c of process.stdin) text += c
const at = process.argv.indexOf('--resume')
const resume = at < 0 ? null : process.argv[at + 1]
appendFileSync(
  'invocations.jsonl',
  JSON.stringify({ text, resume, args: process.argv.slice(2) }) + '\n'
)
// Delegation adds a provider-neutral reporting instruction; route on the original task.
text = text.split('\n\nWorker reporting:')[0]
emit({
  type: 'system',
  subtype: 'init',
  session_id: resume ?? '11111111-1111-4111-8111-111111111111',
})
if (text === 'no-result') process.exit(0)
if (text === 'api-error') {
  emit({ type: 'result', subtype: 'success', is_error: true, result: 'quota' })
  process.exit(1)
}
if (text === 'background') {
  const p = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  writeFileSync('descendant.pid', String(p.pid))
  emit({ type: 'result', subtype: 'success', result: 'done' })
  process.exit(0)
}
if (text === 'worker-loss') {
  emit({ type: 'result', subtype: 'success', result: 'not settled' })
  setTimeout(() => {}, 60000)
} else if (text === 'hang' || text === 'late-result') {
  if (text === 'late-result') {
    let terminating = false
    process.on('SIGTERM', () => {
      if (terminating) return
      terminating = true
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'late completion',
        }) + '\n',
        () => process.exit(0)
      )
    })
  }
  const nested = spawn('/bin/sh', ['-c', 'sleep 60 & wait'])
  writeFileSync('descendant.pid', String(nested.pid))
  emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'started' }] } })
  setTimeout(() => {}, 60000)
} else if (text === 'delegation-report') {
  const report = (id, kind, value) =>
    emit({
      type: 'assistant',
      message: {
        id,
        content: [
          {
            type: 'text',
            text:
              '```abele-worker-report\n' +
              JSON.stringify({ report_id: id, kind, text: value }) +
              '\n```',
          },
        ],
      },
    })
  report('progress', 'progress', 'Working')
  report('progress', 'progress', 'Working') // Final snapshots may be repeated.
  report('question', 'question', 'Which direction?')
  report('result', 'result', 'Structured final answer')
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Structured final answer' })
} else if (text === 'echo') {
  emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'followup' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'followup' })
} else if (text === 'duplicate') {
  const spec = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1]))
    .mcpServers.abele_approval
  const input = { command: 'printf fixture > action.txt' }
  emit({
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'tool_use', id: 'call', name: 'Bash', input }] },
  })
  const request = () =>
    new Promise((resolve) => {
      const bridge = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } })
      let output = ''
      bridge.stdout.on('data', (c) => {
        output += c
        if (!output.includes('\n')) return
        const answer = JSON.parse(JSON.parse(output.split('\n')[0]).result.content[0].text)
        if (answer.behavior === 'deny')
          writeFileSync('duplicate-denied.txt', 'denied while pending')
        bridge.stdin.end()
        resolve(answer.behavior)
      })
      bridge.on('close', () => {
        if (!output) resolve('deny')
      })
      bridge.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'permission',
            arguments: { tool_name: 'Bash', tool_use_id: 'call', input },
          },
        }) + '\n'
      )
    })
  const answers = await Promise.all([request(), request()])
  writeFileSync('duplicate.json', JSON.stringify(answers))
  emit({ type: 'result', subtype: 'success', is_error: false, result: answers.join(',') })
} else {
  const spec = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1]))
    .mcpServers.abele_approval
  if (text === 'bad-token') spec.env.ABELE_APPROVAL_TOKEN = '0'.repeat(64)
  const bridge = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } })
  writeFileSync('bridge.pid', String(bridge.pid))
  const input =
    text === 'reordered'
      ? { command: 'printf fixture > action.txt', description: 'fixture' }
      : { command: 'printf fixture > action.txt' }
  const tool_name = text === 'question' ? 'AskUserQuestion' : 'Bash'
  emit({
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'tool_use', id: 'call', name: tool_name, input }] },
  })
  const sourcesAt = process.argv.indexOf('--setting-sources')
  const sources =
    sourcesAt < 0 ? ['user', 'project', 'local'] : process.argv[sourcesAt + 1].split(',')
  const settingsFiles = [
    ...(sources.includes('user') ? ['fake-user-settings.json'] : []),
    ...(sources.includes('project') ? ['.claude/settings.json'] : []),
    ...(sources.includes('local') ? ['.claude/settings.local.json'] : []),
  ]
  let autoAllowed = false
  if (
    text === 'settings' &&
    settingsFiles.some(
      (file) =>
        existsSync(file) &&
        JSON.parse(readFileSync(file, 'utf8')).permissions?.allow?.includes('Bash')
    )
  ) {
    autoAllowed = true
    writeFileSync('action.txt', 'settings')
    emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call', content: 'executed', is_error: false },
        ],
      },
    })
    bridge.stdin.end()
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'settings' })
  } else
    bridge.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'permission',
          arguments: {
            tool_name,
            tool_use_id: 'call',
            input:
              text === 'mismatch'
                ? { command: 'evil' }
                : text === 'reordered'
                  ? { description: 'fixture', command: input.command }
                  : input,
          },
        },
      }) + '\n'
    )
  let output = ''
  bridge.stdout.on('data', (c) => {
    output += c
    if (!output.includes('\n')) return
    const answer = JSON.parse(JSON.parse(output.split('\n')[0]).result.content[0].text)
    if (answer.behavior === 'allow') writeFileSync('action.txt', 'fixture')
    bridge.stdin.end()
    emit({ type: 'result', subtype: 'success', is_error: false, result: answer.behavior })
  })
  bridge.on('close', () => {
    if (!output && !autoAllowed) emit({ type: 'result', subtype: 'success', result: 'bridge-lost' })
  })
}
