import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

for (const [label, args, toolName, command, expected] of [
  ['one allowed echo command', [], 'Bash', 'printf hello > hello.txt', 'allow'],
  ['deny answer', ['deny'], 'Bash', 'printf hello > hello.txt', 'deny'],
  ['different command', [], 'Bash', 'ls', 'deny'],
  ['different tool', [], 'Write', 'printf hello > hello.txt', 'deny'],
]) {
  test(`MCP responder: ${label}`, () => {
    const cwd = mkdtempSync('/tmp/abele-node-stage0-claude-mcp-test-')
    try {
      const input =
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'permission',
            arguments: { tool_name: toolName, input: { command }, tool_use_id: 'fixture' },
          },
        }) + '\n'
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./approval-mcp.mjs', import.meta.url)), ...args],
        { cwd, input, encoding: 'utf8', timeout: 5000 }
      )
      assert.equal(result.status, 0, result.stderr)
      const answer = JSON.parse(JSON.parse(result.stdout).result.content[0].text)
      assert.equal(answer.behavior, expected)
      const evidence = JSON.parse(readFileSync(`${cwd}/mcp-evidence.jsonl`, 'utf8'))
      assert.equal(evidence.allow, expected === 'allow')
    } finally {
      rmSync(cwd, { recursive: true })
    }
  })
}
