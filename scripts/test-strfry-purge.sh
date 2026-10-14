#!/usr/bin/env bash
set -euo pipefail
export TEST_STRFRY_PURGE=1
exec bash "$(dirname "$0")/test-strfry-policy.sh"
