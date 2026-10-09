import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const result = spawnSync(
  process.execPath,
  [
    '--test',
    'scripts/installer.test.mjs',
    'scripts/install-runtime.test.mjs',
    'scripts/publish-release.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ABELE_INSTALLER_TARBALL: `.scratch/release/abele-node-${version}-${process.platform}-${process.arch}.tar.gz`,
    },
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
