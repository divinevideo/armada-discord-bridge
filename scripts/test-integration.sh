#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable loopback Postgres database}"
bun -e '
import postgres from "postgres";
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Integration tests require a disposable loopback database");
}
const sql = postgres(process.env.DATABASE_URL, {connect_timeout: 5, onnotice() {}});
try { await sql`select 1`; } finally { await sql.end(); }
'
./node_modules/.bin/tsc -b packages/concord-core
./node_modules/.bin/tsc -p packages/portal/tsconfig.json --noEmit
./node_modules/.bin/vite build packages/portal/web
TEST_LOG=$(mktemp)
trap 'rm -f "$TEST_LOG"' EXIT
bun test 2>&1 | tee "$TEST_LOG"
if rg -q '^[[:space:]]+[1-9][0-9]* skip' "$TEST_LOG"; then
  echo 'Integration suite skipped tests; check database and SPA setup.' >&2
  exit 1
fi
