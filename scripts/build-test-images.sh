#!/usr/bin/env bash
# Build locally before publishing. All targets contain the same committed source.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
platform=${BUILD_PLATFORM:-linux/amd64}
: "${IMAGE_PREFIX:=divine-local}"
for target in portal moderation; do
  image="$IMAGE_PREFIX/$target:$revision"
  docker buildx build --platform "$platform" --load --target "$target" --build-arg "VCS_REF=$revision" -t "$image" .
  test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
  docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint bun "$image" -e 'if(process.getuid()!==10001)process.exit(1); await import("./packages/portal/src/env.ts"); await import("./packages/moderation/src/coopHandoff.ts"); console.log("PASS application runtime")'
done
relay="$IMAGE_PREFIX/relay:$revision"
docker buildx build --platform "$platform" --load -f docker/relay.Dockerfile --build-arg "VCS_REF=$revision" -t "$relay" .
test "$(docker image inspect "$relay" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint sh "$relay" -c 'test "$(id -u)" = 10001 && test -r /usr/share/strfry-source/strfry-source.tar && test ! -d /build && /usr/local/bin/strfry --version'
export STRFRY_TEST_IMAGE="$relay"
bash scripts/test-strfry-policy.sh
bash scripts/test-strfry-purge.sh
bash scripts/test-moderation-runtime.sh
