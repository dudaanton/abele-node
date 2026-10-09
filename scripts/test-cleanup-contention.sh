#!/bin/sh
# Run only INSIDE a container limited to one CPU and 2 GiB, never on the host.
set -eu
if [ ! -f /.dockerenv ]; then
  echo 'This script requires a Docker container.' >&2
  exit 1
fi
cd /app
cp -R /source/packages /source/tests /source/scripts /app/
cp /source/package.json /source/package-lock.json /source/.npmrc /source/tsconfig*.json /source/vitest.config.ts /app/
npm ci --ignore-scripts
npm run build
node -e 'for (;;) Math.sqrt(Math.random())' &
load_pid=$!
trap 'kill "$load_pid" 2>/dev/null || true' EXIT INT TERM
failed=0
if [ "$#" -eq 0 ]; then
  set -- tests/claude-stop.test.ts tests/pi-anchor-loss.test.ts tests/pi-process-cleanup.test.ts
fi
total=$(($# * 20))
for file in "$@"; do
  iteration=1
  while [ "$iteration" -le 20 ]; do
    if ./node_modules/.bin/vitest run "$file" --testTimeout 60000 > /app/test-output.log 2>&1; then
      echo "PASS $file $iteration/20"
    else
      echo "FAIL $file $iteration/20"
      cat /app/test-output.log
      failed=$((failed + 1))
    fi
    iteration=$((iteration + 1))
  done
done
echo "Cleanup contention failures: $failed/$total"
test "$failed" -eq 0
