#!/usr/bin/env bash
# Build locally before publishing. All targets contain the same committed source.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
platform=${BUILD_PLATFORM:-linux/amd64}
: "${IMAGE_PREFIX:=divine-local}"
for target in portal moderation bridge; do
  image="$IMAGE_PREFIX/$target:$revision"
  # The final Dockerfile stage is the public default; exercise it without --target.
  target_args=()
  if [ "$target" != bridge ]; then target_args=(--target "$target"); fi
  docker buildx build --platform "$platform" --load "${target_args[@]}" --build-arg "VCS_REF=$revision" -t "$image" .
  test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
  docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint bun "$image" -e 'if(process.getuid()!==10001)process.exit(1); await import("./packages/portal/src/env.ts"); await import("./packages/moderation/src/coopHandoff.ts"); console.log("PASS application runtime")'
  docker run --rm --entrypoint sh "$image" -ec 'test -z "$(find /app -writable -print -quit)"'
done
BRIDGE_TEST_IMAGE="$IMAGE_PREFIX/bridge:$revision" bash scripts/test-bridge-runtime.sh
relay="$IMAGE_PREFIX/relay:$revision"
docker buildx build --platform "$platform" --load -f docker/relay.Dockerfile --build-arg "VCS_REF=$revision" -t "$relay" .
test "$(docker image inspect "$relay" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint sh "$relay" -c 'test "$(id -u)" = 10001 && test -r /usr/share/strfry-source/strfry-source.tar && test ! -d /build && /usr/local/bin/strfry --version'
# Do not use --read-only here: it masks writable code in the image itself.
docker run --rm --entrypoint sh "$relay" -ec '
  test "$(id -u)" = 10001
  test "$(stat -c %u:%g /opt/divine)" = 0:0
  test ! -w /opt/divine
  test ! -w /opt/divine/package.json
  test ! -w /opt/divine/node_modules
  test ! -w /opt/divine/packages/moderation/src
  test -z "$(find /opt/divine -writable -print -quit)"
  if touch /opt/divine/.runtime-write-probe 2>/dev/null; then exit 1; fi
  if printf "\n" >> /opt/divine/package.json 2>/dev/null; then exit 1; fi
  touch /data/.runtime-write-probe
  rm /data/.runtime-write-probe
'
export STRFRY_TEST_IMAGE="$relay"
bash scripts/test-strfry-policy.sh
bash scripts/test-strfry-purge.sh
bash scripts/test-moderation-runtime.sh
