#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Build the existing pinned source and patches, using only its local test stage.
docker build --target strfry-build -f docker/relay.Dockerfile -t bridge-replay-strfry:test .
REPLAY_STRFRY_IMAGE=$(docker image inspect bridge-replay-strfry:test --format '{{.Id}}') bun scripts/fixtures/bridge-replay-interop.ts
