#!/usr/bin/env bash
# Build locally before publishing. All targets contain the same committed source.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Commit tracked changes before building source images.' >&2; exit 1; }
platform=${BUILD_PLATFORM:-linux/amd64}
[[ "$platform" == linux/amd64 ]] || { echo 'Source image contract requires linux/amd64.' >&2; exit 1; }
: "${IMAGE_PREFIX:=divine-local}"
for target in portal moderation bridge; do
  image="$IMAGE_PREFIX/$target:$revision"
  # The final Dockerfile stage is the standalone bridge default; exercise it without --target.
  # Keep the array nonempty: macOS bash 3.2 treats an empty one as unset with -u.
  build_args=(--platform "$platform" --load --build-arg "VCS_REF=$revision" -t "$image")
  if [ "$target" != bridge ]; then build_args+=(--target "$target"); fi
  docker buildx build "${build_args[@]}" .
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

# Export only the deployed portal/moderation/relay set. The standalone bridge
# above stays a separate runtime check and cannot substitute for the portal.
artifacts=${ARTIFACT_DIR:-${TMPDIR:-/tmp}/bridge-source-artifacts-$revision}
python3 scripts/chat-image-artifacts.py build --source "$PWD" --source-sha "$revision" --harness-sha "$revision" --artifacts "$artifacts"
echo "PASS complete source artifacts at $artifacts; no publication performed."
