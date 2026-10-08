globalThis.getterCalls = 0
function investigate() {
  const input = 40
  const object = {
    value: input,
    get computed() {
      globalThis.getterCalls++
      return 99
    },
  }
  const total = input + 2 // BREAKPOINT
  console.log('RESULT', total, object.value)
  try {
    throw new Error('synthetic exception')
  } catch {
    console.log('CAUGHT')
  }
  return total
}
if (process.env.PROBE_TEST) {
  require('node:test')('synthetic result', () =>
    require('node:assert/strict').equal(investigate(), 42)
  )
} else {
  investigate()
  setInterval(() => console.log('HEARTBEAT'), 100)
}
