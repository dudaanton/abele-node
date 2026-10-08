#!/bin/bash
# Explicit B0-only installer. Never called by npm test; nothing global or in production manifests.
set -euo pipefail
cd "$(dirname "$0")/.."
S="$PWD/.scratch/adapters"
E="$PWD/.scratch/evidence"
mkdir -p "$S" "$E"
export UV_CACHE_DIR="$S/uv-cache"
# Use an existing interpreter only; uv must never download a managed Python elsewhere.
export UV_PYTHON_DOWNLOADS=never
export npm_config_cache="$S/npm-cache"
DEP_CHECK="${DEP_CHECK:?Set DEP_CHECK to your dependency-review executable; see docs/debug-probe.md}"
for item in '@vscode/debugadapter 1.68.0' '@vscode/debugadapter-testsupport 1.68.0' '@vscode/debugprotocol 1.68.0' 'typescript 5.9.3'; do
  read -r name version <<< "$item"
  "$DEP_CHECK" check npm "$name" "$version" > "$E/audit-${name##*/}.json"
done
"$DEP_CHECK" check pypi debugpy 1.8.17 > "$E/audit-debugpy.json"
BASE=https://raw.githubusercontent.com/microsoft/vscode-js-debug/v1.140.0
mkdir -p "$S/js-debug-source-audit"
curl -fsSL "$BASE/package.json" -o "$S/js-debug-source-audit/package.json"
curl -fsSL "$BASE/package-lock.json" -o "$S/js-debug-source-audit/package-lock.json"
if ! npm audit --omit=dev --prefix "$S/js-debug-source-audit" --json > "$E/js-debug-source-audit.json"; then
  echo 'WARNING: upstream js-debug lockfile has advisories; see docs/debug-probe.md. Not approved for production.' >&2
  if [ "${ABELE_B0_ALLOW_AUDITED_RELEASE:-0}" != 1 ]; then
    echo 'For this synthetic, disposable B0 check ONLY, explicitly set ABELE_B0_ALLOW_AUDITED_RELEASE=1.' >&2
    exit 1
  fi
fi
URL=https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz
curl -fL "$URL" -o "$S/js-debug-dap-v1.140.0.tar.gz"
echo "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968  $S/js-debug-dap-v1.140.0.tar.gz" | shasum -a 256 -c -
tar -xzf "$S/js-debug-dap-v1.140.0.tar.gz" -C "$S"
# Official archive omits package.json. Isolate its CJS bundle from this repository's type:module.
printf '{"private":true,"type":"commonjs"}\n' > "$S/js-debug/package.json"
npm install --prefix "$S/npm" --ignore-scripts --save-exact \
  typescript@5.9.3 @vscode/debugadapter@1.68.0 @vscode/debugprotocol@1.68.0 @vscode/debugadapter-testsupport@1.68.0
npm audit --prefix "$S/npm" --json > "$E/npm-audit.json"
# Exact Mac CPython 3.12 universal2 wheel; uv is the local venv/package installer.
PY_URL=https://files.pythonhosted.org/packages/08/2b/9d8e65beb2751876c82e1aceb32f328c43ec872711fa80257c7674f45650/debugpy-1.8.17-cp312-cp312-macosx_15_0_universal2.whl
WHEEL="$S/debugpy-1.8.17-cp312-cp312-macosx_15_0_universal2.whl"
curl -fL "$PY_URL" -o "$WHEEL"
echo "f14467edef672195c6f6b8e27ce5005313cb5d03c9239059bc7182b60c176e2d  $WHEEL" | shasum -a 256 -c -
if [ ! -x "$S/venv/bin/python" ]; then uv venv "$S/venv" --python python3.12 --no-python-downloads; fi
uv pip install --python "$S/venv/bin/python" --no-deps "$WHEEL"
node --input-type=module - "$S" "$E" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [s, e] = process.argv.slice(2);
const lock = JSON.parse(await readFile(join(s, 'npm/package-lock.json'), 'utf8'));
await writeFile(join(e, 'npm-installed-artifacts.json'), JSON.stringify(Object.entries(lock.packages)
  .filter(([path]) => path.startsWith('node_modules/'))
  .map(([path, p]) => ({ name: path.slice('node_modules/'.length), version: p.version, source: p.resolved, checksum: p.integrity, license: p.license })), null, 2));
JS
