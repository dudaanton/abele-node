// Inject cold-start scheduling cost, not a synchronization sleep. Only the
// disposable acceptance subprocess inherits this preload; no real provider runs.
if (
  process.argv[1]?.endsWith('/node-daemon/dist/cli.js') &&
  ['status', 'doctor'].includes(process.argv[2])
) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500)
}
