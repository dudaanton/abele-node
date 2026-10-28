import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Build identity uses createProgram/emit, including default-library resolution.
 * Keep the compiler API and its standard libraries, never the separate CLI,
 * language server, translations, API declarations or documentation. */
export function pruneTypeScriptRuntime(staging) {
  const root = join(staging, 'node_modules/typescript')
  for (const name of readdirSync(root)) {
    if (['package.json', 'LICENSE.txt', 'ThirdPartyNoticeText.txt'].includes(name)) continue
    if (name === 'lib') {
      for (const file of readdirSync(join(root, name))) {
        if (file === 'typescript.js' || /^lib(?:\..+)?\.d\.ts$/.test(file)) continue
        rmSync(join(root, name, file), { recursive: true, force: true })
      }
    } else rmSync(join(root, name), { recursive: true, force: true })
  }
  for (const name of ['tsc', 'tsserver'])
    rmSync(join(staging, 'node_modules/.bin', name), { force: true })
}
