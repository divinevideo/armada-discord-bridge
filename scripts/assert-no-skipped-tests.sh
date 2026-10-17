#!/usr/bin/env bash
set -euo pipefail
: "${1:?Usage: bash scripts/assert-no-skipped-tests.sh TEST_LOG}"
# Match only Bun's whole summary line, not a test name or a substring of a count.
# Do not use -q: a match must not hide a later read error. Only status 1 means
# no skips; a missing matcher or unreadable log must never make CI green.
if grep -E '^[[:space:]]*[1-9][0-9]* skip[[:space:]]*$' "$1" >/dev/null; then
  echo 'Integration suite skipped tests; check database and SPA setup.' >&2
  exit 1
else
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "Cannot check integration skips (grep exited $status)." >&2
    exit "$status"
  fi
fi
