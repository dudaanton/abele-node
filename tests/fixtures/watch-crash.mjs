import { writeSync } from 'node:fs'
export function watch() {
  writeSync(2, 'watch fixture startup crashed\n')
  process.exit(7)
}
