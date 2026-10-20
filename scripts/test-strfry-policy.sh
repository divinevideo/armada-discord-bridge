#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${STRFRY_TEST_IMAGE:=divine-concord-relay:test}"
image_id=$(docker image inspect "$STRFRY_TEST_IMAGE" --format '{{.Id}}')
export STRFRY_TEST_IMAGE="$image_id"
bun scripts/fixtures/strfry-policy-integration.ts
