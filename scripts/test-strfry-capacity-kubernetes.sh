#!/usr/bin/env bash
# Explicitly opted-in private benchmark only; never creates a public Service or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CAPACITY_KUBERNETES_CONFIG:?Select the reviewed destination metadata JSON.}"
: "${CAPACITY_DATABASE_URL:?Supply the dedicated benchmark DB connection privately.}"
: "${CAPACITY_OUTPUT_DIR:?Select a private absolute output directory outside the checkout.}"
[[ "${CAPACITY_EXECUTE_DESTINATION:-}" == 1 ]] || { echo 'Set CAPACITY_EXECUTE_DESTINATION=1 only for an authorized isolated measurement.' >&2; exit 1; }
: "${CAPACITY_MATRIX:=scripts/fixtures/capacity-matrix-destination.json}"
: "${CAPACITY_MODE:=calibration}"
[[ "$CAPACITY_MODE" == calibration || "$CAPACITY_MODE" == entrypoint ]] || { echo 'CAPACITY_MODE must be calibration or entrypoint.' >&2; exit 1; }
if [[ "$CAPACITY_MODE" == entrypoint ]]; then : "${CAPACITY_CONTRACT_FILE:?Entrypoint replay requires the reviewed candidate contract.}"; fi
export CAPACITY_MATRIX CAPACITY_MODE
bun scripts/fixtures/strfry-capacity.ts
