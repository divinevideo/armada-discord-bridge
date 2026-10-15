#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
gate="$PWD/scripts/assert-no-skipped-tests.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
expect_failure() {
  if "$@" >"$work/output" 2>&1; then
    echo "Skipped-test gate unexpectedly passed: $*" >&2
    exit 1
  fi
}
printf ' 42 pass\n 0 skip\n 0 fail\n' >"$work/log"
bash "$gate" "$work/log"
for count in 1 9 10 123; do
  printf ' 42 pass\n %s skip\n 0 fail\n' "$count" >"$work/log"
  expect_failure bash "$gate" "$work/log"
done
printf '(pass) mentions 12 skip in a test name\n 12 skipped-by-name\n 12 skip suffix\n 42 pass\n 0 skip\n' >"$work/log"
bash "$gate" "$work/log"
expect_failure bash "$gate" "$work/missing-log"
mkdir "$work/bin"
# Absolute bash keeps the gate runnable while its matcher is absent from PATH.
expect_failure env PATH="$work/bin" "$(command -v bash)" "$gate" "$work/log"
printf '#!/bin/sh\nexit 2\n' >"$work/bin/grep"
chmod +x "$work/bin/grep"
expect_failure env PATH="$work/bin" "$(command -v bash)" "$gate" "$work/log"
echo 'PASS skipped-test gate: bounded summaries, missing matcher, matcher errors'
