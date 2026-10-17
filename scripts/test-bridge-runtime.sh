#!/usr/bin/env bash
set -euo pipefail
: "${BRIDGE_TEST_IMAGE:?Set BRIDGE_TEST_IMAGE to the built default image}"
work=$(mktemp -d)
name="bridge-runtime-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
network="$name-network"
database="$name-db"
cleanup() {
  docker rm -fv "$name" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# A private network and fresh container keep migrations off every existing DB.
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=bridge -e POSTGRES_DB=bridge \
  postgres:16@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6 >/dev/null
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$database" pg_isready -h 127.0.0.1 -U bridge -d bridge >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs "$database" >&2
  exit 1
fi
# Public, deterministic test-only key material; no live Discord/invite config.
# No entrypoint or command override: this must run the actual default startup.
for mode in legacy public; do
  mode_args=(-e "BRIDGE_MODE=$mode")
  if [ "$mode" = public ]; then
    mode_args+=(-e 'BRIDGE_PUBLIC_CHANNELS={"guildId":"100000000000000001","channelIds":["100000000000000002"],"excludedCategoryIds":["100000000000000003"]}')
  fi
  if ! timeout 90s docker run --rm --name "$name" --network "$network" \
    "${mode_args[@]}" \
    -e "DATABASE_URL=postgres://bridge@$database:5432/bridge" \
    -e BRIDGE_MASTER_SECRET=0000000000000000000000000000000000000000000000000000000000000001 \
    -e BRIDGE_PRIMARY_KEY=0000000000000000000000000000000000000000000000000000000000000001 \
    "$BRIDGE_TEST_IMAGE" >"$work/startup.log" 2>&1; then
    cat "$work/startup.log" >&2
    exit 1
  fi
  cat "$work/startup.log"
  grep -F 'bridge: config OK; set BRIDGE_INVITE_URL, DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID to go live' "$work/startup.log" >/dev/null
done
# Explicit public mode must not downgrade when its required policy is absent.
if docker run --rm --network "$network" -e BRIDGE_MODE=public \
  -e "DATABASE_URL=postgres://bridge@$database:5432/bridge" \
  -e BRIDGE_MASTER_SECRET=0000000000000000000000000000000000000000000000000000000000000001 \
  -e BRIDGE_PRIMARY_KEY=0000000000000000000000000000000000000000000000000000000000000001 \
  "$BRIDGE_TEST_IMAGE" >"$work/public-missing.log" 2>&1; then
  echo 'FAIL public mode accepted missing policy' >&2
  exit 1
fi
grep -F BRIDGE_PUBLIC_CHANNELS "$work/public-missing.log" >/dev/null

# Prove startup really migrated the fresh DB rather than only importing modules.
test "$(docker exec "$database" psql -U bridge -d bridge -Atc 'SELECT count(*) > 0 FROM schema_migrations')" = t
echo 'PASS default bridge image: legacy/public config-only startup, fail-closed policy and disposable DB migrations'
