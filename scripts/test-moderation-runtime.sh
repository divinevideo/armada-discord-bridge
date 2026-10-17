#!/usr/bin/env bash
set -euo pipefail
export TEST_MODERATION_RUNTIME=1
exec bash "$(dirname "$0")/test-strfry-policy.sh"
