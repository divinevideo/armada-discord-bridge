#!/usr/bin/env bash
# Disposable loopback resources only. No image build, registry login, push or live service.
set -euo pipefail
cd "$(dirname "$0")/.."
# The harness picks its backend from these, so a shell that still exports them
# from a destination run would make this "loopback only" script create Pods in
# a live cluster and write fixtures to its benchmark database.
unset CAPACITY_KUBERNETES_CONFIG CAPACITY_EXECUTE_DESTINATION CAPACITY_DATABASE_URL
: "${STRFRY_TEST_IMAGE:?Set the exact locally built relay candidate image.}"
: "${CAPACITY_MATRIX:=scripts/fixtures/capacity-matrix.json}"
: "${CAPACITY_MODE:=calibration}"
[[ "$CAPACITY_MODE" == calibration || "$CAPACITY_MODE" == entrypoint ]] || { echo 'CAPACITY_MODE must be calibration or entrypoint.' >&2; exit 1; }
if [[ "$CAPACITY_MODE" == entrypoint ]]; then : "${CAPACITY_CONTRACT_FILE:?Actual entrypoint measurement requires a reviewed measured contract.}"; fi
image_id=$(docker image inspect "$STRFRY_TEST_IMAGE" --format '{{.Id}}')
export STRFRY_TEST_IMAGE="$image_id" CAPACITY_MATRIX CAPACITY_MODE
bun scripts/fixtures/strfry-capacity.ts
