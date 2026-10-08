import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('scratch installer forbids uv-managed Python downloads, including on venv creation', async () => {
  // Do not reproduce by actually downloading a Python outside the worktree.
  const source = await readFile(new URL('./debug-install.sh', import.meta.url), 'utf8')
  assert.match(source, /^export UV_PYTHON_DOWNLOADS=never$/m)
  assert.match(source, /uv venv[^\n]*--no-python-downloads/)
  assert.ok(source.indexOf('export UV_PYTHON_DOWNLOADS=never') < source.indexOf('uv venv'))
})
