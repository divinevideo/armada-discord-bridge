# Bridge improvements Armada already supports

Work the bridge can ship now, using protocol pieces that exist in
`concord-core` and behaviors the Armada client already renders. Companion
to `NEXT-STEPS.md`; this file is scoped to items where the Armada side is
done and the gap is purely in this repo.

## Do now (SHIPPED 2026-07-31)

All five landed: cursors + bounded backfill (Concord -> Discord), puppet
guestbook joins, the custom-emoji reverse direction (`applyCustomEmoji`;
the forward direction already existed), typing both ways, and the kind
10304 manifest. Remainders moved to `NEXT-STEPS.md`: Discord -> Concord
downtime catch-up, guestbook leaves, and per-relay cursor granularity.
Original items kept below for the reasoning.

### 1. Cursor persistence and bounded backfill
Messages sent while the bridge is down are lost. The `cursors` table
exists but nothing writes it; relays already answer `until`/`limit`
pagination and the mapping table dedupes. Persist per-(stream, relay)
high-water marks, advance them as the router mirrors, and run a bounded
backfill on boot. Already agreed as next up in `NEXT-STEPS.md`.

### 2. Guestbook joins for puppets (kind 3306)
Puppets appear in the Armada member list only after speaking. Publish a
join on first message (or at history import, where a channel can gain
dozens of members at once). A leave on `GUILD_MEMBER_REMOVE` is optional
since it needs the GUILD_MEMBERS privileged intent.

### 3. Custom emoji as NIP-30 tags
Import already packs guild emoji into the community; live messages still
flatten `<:name:id>` to `:name:`. Carry `emoji` tags pointing at the
packed images so Armada renders the real emoji.

### 4. Typing indicators (kind 23311)
Discord `TYPING_START` maps to kind 23311 over the ephemeral 21059 wrap,
and back out via `POST /typing`. Core supports the wrap path; the router
just never publishes it. Cheap, and it makes the bridge feel live.

### 5. Bot manifest (kind 10304)
The `/bridge confirm` and `/claim` commands are only discoverable through
posted message text. Publishing the manifest makes them first-class in
Armada clients that read it.

## Do now (SHIPPED 2026-08-02)

Channel structure caught up with Armada 0.45.0: the importer publishes
categories and ordering under the `armada.category` / `armada.order`
metadata members the client reads, imports role-gated Private Channels
instead of skipping them, and the bridge takes delivery of private-channel
keys from its Direct Invite inbox. `concord-core` was re-vendored from
`concord-v2/lib` (it had drifted far enough to be missing the CORD-04 §5
citation check the client shipped in 0.43.0); `sync-from-armada.sh` makes
that repeatable. See NEXT-STEPS.md section 2 for what is still open.

## Later

- Rekey rollover: `rekey.ts` has `parseRekey`, `groupRotations`, and
  `checkContinuity`, but the client never subscribes to the rekey
  addresses, so a Refounding severs the bridge until relink — and a
  channel-scope rotation (what a revoke does) leaves a Private Channel
  silently unreadable. This is now the gate on live-bridging the Private
  Channels the importer creates, not just a latent risk.
- Dissolution watch: kind 3308 vsk 10 is not observed; the bridge should
  sever itself with honest copy instead of erroring per message.
- Mentions: `nostr:npub...` references to puppet identities can resolve
  back to real `<@id>` pings via the existing derivation.
- Edits on by default: kind 3302 works behind `BRIDGE_EDITS`; wire the
  stored `options` jsonb so it is a per-bridge toggle instead of an env
  flag (reactions/attachments/typing toggles belong to the same screen).
- Zaps as reactions: kinds 9735/8333 arrive on bridged messages today and
  vanish. Mirroring them as a Discord reaction (or a short webhook note)
  closes the loop cheaply.
- History import polish: surface per-channel progress and the skip
  reasons (bot-authored, empty after conversion) in the dashboard instead
  of container logs; today's debugging showed how opaque a silent skip is.
