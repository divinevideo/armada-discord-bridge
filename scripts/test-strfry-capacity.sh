#!/usr/bin/env bash
# Disposable loopback resources only. No image build, registry login, push or live service.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${STRFRY_TEST_IMAGE:?Set the exact locally built relay candidate image.}"
: "${CAPACITY_MATRIX:=scripts/fixtures/capacity-matrix.json}"
: "${CAPACITY_MODE:=calibration}"
[[ "$CAPACITY_MODE" == calibration || "$CAPACITY_MODE" == entrypoint ]] || { echo 'CAPACITY_MODE must be calibration or entrypoint.' >&2; exit 1; }
if [[ "$CAPACITY_MODE" == entrypoint ]]; then : "${CAPACITY_CONTRACT_FILE:?Actual entrypoint measurement requires a reviewed measured contract.}"; fi
image_id=$(docker image inspect "$STRFRY_TEST_IMAGE" --format '{{.Id}}')
export STRFRY_TEST_IMAGE="$image_id" CAPACITY_MATRIX CAPACITY_MODE
bun scripts/fixtures/strfry-capacity.ts
