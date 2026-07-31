# Plan: message history import + claiming your old account

Status: draft for review. Nothing here is built. Follows
`armada-server-import-PLAN.md` (shipped): imported communities are owned by
the user's key, with the portal's operational key holding a revocable Admin
grant.

Goal, in two halves that reinforce each other:

1. History: a bridged channel can backfill its Discord message history into
   the Armada channel, with real timestamps, real authorship (the same puppet
   identities live bridging uses), replies, and attachments.
2. Claiming: a person who was active in the Discord server proves they own
   their Discord account (OAuth — we assume users still have Discord access)
   and links it to their Armada key, so their imported history becomes
   *theirs*: profile linked, imported Discord roles granted to their npub,
   and optionally the puppet key handed over.

## 1. What the research established

### 1.1 Discord API (from the earlier server-import research)

- `GET /channels/{id}/messages?limit=100&after={snowflake}` walks a channel
  oldest → newest. Requires `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` (both in
  our install permissions) and the Message Content privileged intent, which
  the bot already runs with for live mirroring.
- Rate budget: 50 req/s global, per-route buckets per channel. The REST crawl
  is never the bottleneck (a million-message channel is ~10k requests); the
  Concord side (encrypt + publish one wrap per message) is.
- Reactions are expensive: reactor lists cost one paginated request per emoji
  per message. Threads need per-channel archived-thread walks. Both deferred
  (§6).
- `GET /users/@me/guilds/{guild.id}/member` with the user's OAuth token
  (scope `guilds.members.read`) returns that user's roles + nick in the
  guild. No privileged intent, and it doubles as proof of guild membership —
  the key primitive for claiming with roles.

### 1.2 What the bridge already has

- Puppets are STATELESS: `derivePuppet(masterSecret, discordUserId)`
  (`packages/bridge/src/puppets.ts:32`) HKDF-derives the same keypair every
  time, per (community, guild) master secret (`guild_community_secrets`).
  History import and live bridging automatically share identities, and a
  claimed user's puppet secret is recoverable on demand — no key storage.
- `buildRumor` takes `ms` (epoch milliseconds): `created_at` carries the
  seconds, the `ms` tag the remainder (`stream.ts:79`). Historical messages
  can be published AT their original Discord timestamps, and Concord clients
  order by exactly that.
- The `messages` table (`schema.sql:37`) maps discord message id ↔ rumor id
  with origin + author; it is the natural dedupe ledger between backfill and
  the live bridge, and the reply-resolution index (a crawled reply looks up
  its parent's rumor id for the `q` tag).
- The `cursors` table exists, unused — made for resumable backfill.
- Attachment rehosting (Blossom + imeta), message splitting, markdown
  transform, and the NIP-48 `proxy` provenance tag all exist in the live
  router and are reusable as-is.

### 1.3 Prior art

- Nobody consumer-grade imports Discord history (Guilded, GameVox: structure
  only). The one ecosystem that does it right is Matrix: DiscordChatExporter
  JSON fed through an importer that uses timestamp override + ghost users.
  Our puppet system IS the ghost-user system, and Concord's `ms` tag is the
  timestamp override, so the bridge can do this natively off the live API.
- Identity claiming precedent: Zulip's Discord guidance ("log in with Discord
  OAuth so members arrive as themselves"), Slack importers matching by email.
  Discord exposes no emails; OAuth-as-proof is the only honest mechanism,
  and we already run Discord OAuth.

## 2. Design: history import

### 2.1 Pipeline

Per bridged channel (imported or hand-paired), a `HistoryJob`:

1. Crawl: REST-walk the channel oldest → newest (`after=` pagination),
   starting from the channel-id snowflake or the stored cursor. Live bridge
   stays on; the `messages` table dedupes the overlap window.
2. Transform: same path as live (markdown transform, splitting, attachment
   rehost via Blossom, gif transcode). Skips: system messages (joins, pins,
   boosts), messages already in `messages`, other bridges' webhook echoes
   (existing loop-prevention checks).
3. Publish: kind 9 rumor per message, signed by the author's puppet,
   `ms` = the Discord timestamp (snowflake >> 22 + epoch), the `proxy`
   permalink tag, `q` tag when the referenced parent is already mapped
   (oldest-first crawl makes parents resolve). Edited messages import their
   FINAL content; deleted messages are simply absent.
4. Record: insert the `messages` row (same shape as live), advance the
   cursor (`cursors` reused with `stream_pk = 'backfill:' + discord channel
   id`, `last_seen_at` = last message snowflake), checkpoint every batch.
5. Profiles: first time a puppet appears, publish its kind 0 (existing
   profile path); member list coherence via observed-author semantics —
   Concord counts anyone seen publishing as present, so no guestbook spam.

### 2.2 Bounds, ordering, backpressure

- Decided caps: history import is only offered for servers with at most 100
  members (guild `approximate_member_count`); larger servers see "Message
  history is not currently available for larger servers." Per channel, the
  newest 10,000 messages import (the crawl finds the start point, then walks
  oldest → newest).
- Throughput target ~20-40 publishes/s per community (encrypt + any-accept
  publish dominates); REST crawl throttled beneath it. One worker per
  community, channels sequential (a paused job resumes from its cursor).
- Publishing history to a channel people are already chatting in is safe:
  Concord ordering is by `ms`, so history slots beneath the live traffic.

### 2.3 The backdating risk (must spike first)

Everything above assumes the community relays ACCEPT events whose
`created_at` is months or years old. Wraps are `created_at = now()`
(`wrapSeal` stamps the wrap at send time — only the inner rumor is old), so
relay-side rejection is actually unlikely: relays only ever see the wrap.
Milestone 0 is a spike proving a year-old rumor inside a fresh wrap renders
correctly in the Armada client (ordering, day dividers, "edited" markers).

### 2.4 UX

- Server-import wizard grows a per-channel "import history" option next to
  "bridge live", plus the bound selector and a cost warning.
- Existing bridges get an "Import history" button on the dashboard card.
- Progress: per-channel imported/total counts on the import status row
  (jsonb checkpoints, same pattern as the structure import).

## 3. Design: claiming your old account

The user's Discord OAuth session is the ownership proof for a Discord user
id; their Armada login (the existing in-browser nsec/NIP-07 component) is
the ownership proof for an npub — the server verifies a signed claim event
against a challenge, reusing the template-signing plumbing from the import.

A claim has three levels, each independently useful:

### 3.1 Level 1 — link (default, automatic)

- The puppet's kind 0 is republished with the claim recorded:
  `{ ...existing profile, claimed_by: <npub> }`, and a pair of attestation
  events is published to the community relays: puppet-signed "I am claimed
  by npub X" and npub-signed "puppet Y is me" (dual signature prevents
  either side from being forged alone).
- Today's clients render nothing new (harmless); an Armada client that
  understands the attestation can merge the puppet's history into the real
  account's display — name, avatar, one click to the real profile. Needs
  client coordination; the attestation format is Open Question 2.

### 3.2 Level 2 — roles (the immediately valuable one)

- Portal OAuth gains the `guilds.members.read` scope (user token, no
  privileged intent). At claim time the portal reads the member's CURRENT
  roles in the guild, maps them through the imported role table
  (`plan.roles[].roleIdHex` from the server import), and the operational
  key publishes a grant edition (vac-cited) assigning those roles to the
  claimed npub.
- Result: a Discord moderator claims and is instantly a moderator in
  Armada, with the same role names and colors. No client changes needed.

### 3.3 Level 3 — key handover (opt-in, advanced)

- The portal derives the puppet secret and reveals its nsec to the claimant
  once, in-browser, after both proofs.
- Honest disclosure in the UI: the key is DERIVED, so the bridge can always
  re-derive it — this is shared custody, not transfer. The bridge keeps
  signing their live Discord messages with it (that continuity is the
  point). Anyone uncomfortable with that uses Level 1+2 and posts natively
  with their own key.
- Not offered for communities whose master secret was destroyed (unlinked
  bridges).

### 3.4 Claim UX

- New portal page "Claim your history": Discord login (existing) → list of
  communities where this Discord user has bridged/imported messages (query
  `messages` by `author_ref` + `origin='discord'` joined to
  `guild_community_secrets`) → Armada login (existing component) → pick
  levels → sign the claim challenge (+ receive the nsec for Level 3).
- New `claims` table: (tenant, community_id, discord_guild_id,
  discord_user_id, npub, levels, created_at). One claim per (community,
  discord user); re-claiming to a different npub requires revoking first
  (Open Question 3).

## 4. Changes by package

- `bridge`: `HistoryCrawler` (REST pagination + snowflake time math),
  `HistoryPublisher` (reuses router transform pieces; new entry point that
  bypasses the gateway), cursor read/write helpers.
- `portal`: history job runner inside BridgeManager's worker (respects
  leases when those land), wizard + dashboard UI, claim page, claim API
  (`POST /api/claims` etc.), OAuth scope addition, `claims` migration
  (008), grant-edition publishing for Level 2 (reuses importer's vac
  machinery).
- `concord-core`: nothing for history; possibly the attestation event
  builder for Level 1 once the format is agreed.

## 5. Rate/volume budget (honest numbers for the UI)

- 10k messages ≈ 100 REST requests ≈ instant; publishing at ~30/s ≈ 6 min.
- 100k messages ≈ 1h; 1M ≈ half a day, plus attachment rehosting.
- Attachments dominate when present (download + upload each); cap per-file
  size (existing blob cap) and total per-channel rehost budget, with
  "skip attachments" as a wizard option for huge channels.

## 6. Explicitly out of scope for v1 (phase 2 candidates)

1. Reactions (1+ request per emoji per reacted message; needs its own
   budget and an opt-in).
2. Threads and forum channels (kind 1111 mapping exists in the protocol;
   bridge-side thread support should land for LIVE traffic first).
3. Pins (`custom.pinned` or a client feature), stickers, polls.
4. Edit history (final content only), ephemeral/system messages.
5. Auto-claim invites (DMing Discord users "claim your account here") —
   bots cannot DM without a shared-guild interaction and it smells like
   spam; the community owner shares the claim link instead.

## 6b. Custom emoji (added after reading the Armada client source)

The client's emoji model makes Discord custom emoji fully bridgeable:

- In messages and kind 7 reactions, `:shortcode:` renders from a
  SELF-CONTAINED `["emoji", shortcode, url]` tag inside the rumor
  (`src/lib/customEmoji.ts`, `chat.ts:317`); readers need no pack. So the
  bridge translates Discord's `<:name:id>` to `:name:` plus an emoji tag
  pointing at the stable emoji CDN URL, in live traffic and history alike,
  and custom-emoji reactions stop being skipped.
- Community emoji sets don't exist in Concord V2; the client's palette is a
  personal kind 10030 list referencing kind 30030 emoji-set events that any
  user may publish. The import therefore publishes ONE kind 30030 pack
  ("<guild> emoji", `d = discord-import`, one emoji tag per guild emoji,
  images rehosted to Blossom) signed by the operational key, records its
  address in `CommunityMetadata.custom.emojiPack` (the sanctioned extension
  slot) for future clients, and shows the pack address in the summary so
  members can add it to their palette today.

## 7. Open questions

1. OQ1 RESOLVED by reading the client: no age checks on chat rumors,
   ordering and day dividers key off the rumor's own ms, and REQ filters run
   on the wrap's fresh `created_at` — backfilled history renders correctly.
   One caveat: the render window starts at the newest 100 rumors, so old
   history appears as users scroll up. No spike needed.
2. OQ2: the claim attestation format for Level 1 — needs agreement with the
   Armada client team (confirmed: the client has NO identity-linking support
   today; kind 0 `claimed_by` field ships first as a forward-compatible
   marker). Level 2 ships without it.
3. OQ3: claim revocation/re-claim policy — who can undo a claim, and what
   happens to granted roles (owner/op revokes the grant edition).
4. OQ4: should history import be offered on communities the bridge merely
   JOINED (not imported)? The op key holds no Admin there; publishing
   history needs no authority (chat is key-possession), so probably yes —
   but the community's moderators only consented to a live bridge. Proposal:
   require a fresh in-channel `/bridge confirm` for history on non-imported
   communities.
5. OQ5: does publishing thousands of backdated wraps trip relay rate
   limits / max-event-per-connection policies on the stock relays; needed
   pacing per relay.

## 8. Milestones

1. M0 spike: hand-publish a 1-year-old rumor in a fresh wrap to a test
   community; verify client rendering + relay acceptance (OQ1, OQ5).
2. M1 history engine: crawler + publisher + cursors, CLI/flag-driven, one
   channel, bounded, no UI. End-to-end test against fixture REST + wire.
3. M2 history UX: wizard toggle + bounds, dashboard button, progress,
   consent gate for non-imported communities (OQ4).
4. M3 claims Level 2 + 1: claims table, claim page, OAuth scope, role
   grants; attestation events behind a flag until OQ2 settles.
5. M4 claims Level 3: puppet nsec reveal with the shared-custody
   disclosure.
6. M5 phase-2 backlog: reactions, threads, pins.
