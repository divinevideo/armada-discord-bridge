#!/usr/bin/env bash
#
# Re-vendor the protocol files from the Armada client.
#
# concord-core is a COPY of armada's `src/concord/lib`, not a rewrite: the
# bridge folds the same control plane as the client and must agree with it on
# authority, key custody and history spanning. Hand-merging drifted the copy
# badly enough that channel categories/ordering, private-channel key priors and
# the CORD-04 §5 citation check were all missing here while shipped there.
#
# Only the files listed below are copied. Everything else in this package
# (stream.ts, join.ts, vendor/*, index.ts) diverges on purpose — the core has no
# store, so it never parks an unopened wrap and its OpenedEvent always carries
# the envelope.
#
# The client-only edges are rewritten mechanically:
#   @/concord/lib/X  -> ./X            (path alias)
#   @/lib/gitActivity   -> ./vendor/...   (already vendored)
#   @/lib/nip17/protocol-> ./vendor/nip17 (the 3 expiry/timer fns chat.ts uses)
#   NostrRumor          -> Rumor          (core defines its own in stream.ts)
#   perfCount(...)      -> dropped        (client instrumentation)
#
# Usage: ./sync-from-armada.sh [path-to-armada-checkout]
# Review the diff afterwards; a rewrite that no longer applies fails typecheck.
set -euo pipefail

ARMADA="${1:-../../../armada}"
SRC="$ARMADA/src/concord/lib"
DEST="$(cd "$(dirname "$0")" && pwd)/src"

[ -d "$SRC" ] || { echo "no armada lib at $SRC" >&2; exit 1; }

FILES=(
  derive.ts version.ts edition.ts kinds.ts types.ts
  chat.ts control.ts roles.ts guestbook.ts
  invite.ts inviteRelays.ts directInvite.ts
  community.ts communityList.ts rekey.ts streamAuth.ts
  channelCategory.ts channelOrder.ts channelAccess.ts
)

# Upstream's own tests come along: they are the only check that a copy is
# faithful rather than merely type-correct.
#
# One hand-edit survives each sync: control.test.ts's Pin List case ends with a
# `readPinList` assertion, and pins.ts is deliberately not vendored (it needs
# nip44keys.ts and two more deps, and the bridge folds Pin Lists but never
# renders them). Drop that one line and its `./pins` import after syncing.
#
# The Banlist section of control.ts was fixed here first — a moderator could
# ban every admin above them, a banned BAN holder could publish the version
# that unbanned them, and equal-version forks were decided on the grindable
# rumor id. The same fix now lives upstream, so the two are byte-identical and
# a sync is a no-op there rather than a silent revert. `controlBanlist.test.ts`
# is not vendored and pins the behaviour from this side; upstream's own
# control.test.ts covers it too, and once a sync has brought those down the
# local file is duplicate coverage and can go.
#
# Excluded, and kept as this repo's own: `protocol.test.ts` (bridge-specific),
# `chat.test.ts` and `directInvite.test.ts` (they need client test infra —
# @nostrify/indexeddb, a bolt11 mock, vitest's importOriginal mocking — and
# they build OpenedChat literals without the wrap envelope, which the client's
# store-backed OpenedEvent makes optional and this package does not).
TESTS=(
  derive.test.ts control.test.ts roles.test.ts guestbook.test.ts
  invite.test.ts inviteRelays.test.ts rekey.test.ts
  community.test.ts communityList.test.ts streamAuth.test.ts
  channelCategory.test.ts channelOrder.test.ts channelAccess.test.ts
)
FILES+=("${TESTS[@]}")

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "missing upstream: $f" >&2; exit 1; }
  sed -E \
    -e 's#"@/concord/lib/([A-Za-z0-9_]+)"#"./\1"#g' \
    -e 's#"@/lib/(gitActivity|platform|zaps|calendar|polls|foldedCache)"#"./vendor/\1"#g' \
    -e 's#"@/lib/nip17/protocol"#"./vendor/nip17"#g' \
    -e 's#"@/hooks/useDmRelayList"#"./vendor/dmRelays"#g' \
    -e 's#"@/hooks/useReactions"#"./vendor/reactions"#g' \
    -e 's#"vitest"#"bun:test"#g' \
    -e '/from "@\/lib\/nostrRumor"/d' \
    -e '/from "@\/lib\/perf"/d' \
    -e '/^\s*(const start = performance\.now\(\);|perfCount\()/d' \
    -e 's#\bNostrRumor\b#Rumor#g' \
    "$SRC/$f" > "$DEST/$f"
done

# `Rumor` replaces the client's NostrRumor import, so every file that names it
# has to pull it from stream.ts. Done here rather than in sed because it is an
# insertion, not a substitution.
for f in "${FILES[@]}"; do
  dest="$DEST/$f"
  grep -q '\bRumor\b' "$dest" || continue
  grep -q 'type Rumor' "$dest" && continue
  if grep -q 'from "./stream"' "$dest"; then
    sed -i -E 's#(import \{[^}]*[^ }]) *(\} from "\./stream";)#\1, type Rumor \2#' "$dest"
  else
    sed -i -E '0,/^import /s##import type { Rumor } from "./stream";\nimport #' "$dest"
  fi
done

echo "vendored ${#FILES[@]} files from $SRC"
echo "now run: bun run typecheck && bun test"
