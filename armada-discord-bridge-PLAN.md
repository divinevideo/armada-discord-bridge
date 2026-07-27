# Discord <-> Armada (Concord) bridge: implementation plan

A standalone service that mirrors messages between a Discord guild channel and an
Armada/Concord community channel, in both directions, with per-user attribution on
both sides. It is a separate deployable, never part of the Armada client. Its purpose
is onboarding: a Discord community can see and talk to its Armada counterpart before
members migrate.

Sources for this plan: the CORD-01..07 specs in `~/Projects/concord`, Armada's
implementation in `~/Projects/armada/src/concord-v2/`, the Discord Gateway/webhook
docs, and three reference bridges (revcord for Revolt/Stoat, matrix-appservice-discord,
and Mostr for Nostr identity derivation).

---

## 1. The two sides, summarized

### Concord side (what Armada speaks)

- No server API. Everything is Nostr relay WebSocket traffic. The bridge is
  architecturally just another community member.
- Every event is a kind `1059` gift wrap (`21059` ephemeral) signed by a *derived
  stream key* (the address you filter on with `authors`), containing a seal (kind
  `20013` encrypted) signed by the author's **real** key, containing an unsigned rumor
  with the functional kind. Authorship = the seal key. There is no way to fake a
  display name on someone else's key.
- Membership is possession of `community_root` (plus per-channel keys for private
  channels), obtained through an invite (kind `33301` bundle or `3313` direct invite).
  The invite also carries the community relay set (max 5 relays).
- Rumor kinds the bridge cares about:

  | kind | meaning | notes |
  |---|---|---|
  | 9 | chat message | content = text; `q` tag = inline quote |
  | 1111 | threaded reply | NIP-22 `K/E/P` root + `k/e/p` parent, rumor ids |
  | 7 | reaction | `e` target, `k` "9"/"1111", content = emoji; NIP-30 `emoji` tag for custom |
  | 5 | delete | own messages only |
  | 3302 | edit | **payload not frozen in spec yet, treat as provisional** |
  | 23311 / 23313 | typing / voice presence | ephemeral |
  | 3306 / 3309 | guestbook join-leave / kick | |
  | 3308 / 3303 | control editions / rekeys | must be folded to stay functional |

- Every chat rumor MUST carry `["channel", <id>]` and `["epoch", "<n>"]` matching the
  key that wraps it, plus `["ms", "0..999"]`. NIP-44 caps plaintext at 65,535 bytes
  per layer.
- The bridge must fold the Control Plane (channels, roles, Banlist), track epochs, and
  subscribe to the precomputed rekey addresses. Missing a Refounding permanently
  severs the bridge from the community. Spam defense is structural (Ban + Refounding),
  not rate limits, so the bridge must self-throttle and respect bans.
- Media: Blossom (BUD-02) uploads, referenced by NIP-92 `imeta` tags on the message
  rumor. Armada supports client-side AES-256-GCM encryption of attachments with
  `decryption-key` / `decryption-nonce` in the imeta (`src/lib/encryptedMedia.ts`).
- Armada already has a bot convention: kind `10304` command manifest + `"bot": true`
  in kind 0 (see armada `NIP.md`). The bridge's primary identity should use it.

### Discord side

- Bot over Gateway v10 (WebSocket, heartbeat/resume protocol) + HTTP API.
- Required intents: `GUILDS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, and the
  privileged `MESSAGE_CONTENT` (toggle in the dev portal; needs review only past
  10,000 users). Optional: `GUILD_MESSAGE_TYPING`.
- Incoming events: `MESSAGE_CREATE/UPDATE/DELETE`, `MESSAGE_REACTION_ADD/REMOVE`,
  `CHANNEL_UPDATE`, `GUILD_MEMBER_*` (only if we sync profiles).
- Outgoing impersonation: **one webhook per bridged Discord channel**, with per-message
  `username` and `avatar_url` overrides. This is how every Discord bridge (revcord,
  matrix-appservice-discord) renders remote users, and it needs no puppet accounts.
  Webhooks can also `PATCH`/`DELETE` their own past messages, which covers edits and
  deletes.
- Constraints: 2,000-char message limit (split long Concord messages), attachment
  URLs on Discord's CDN are signed and expire (so re-host, never hotlink), webhook
  rate limit ~5 req / 2 s per webhook plus global limits.

---

## 2. Architecture

```
 Discord guild                      bridge service                     Nostr relays
+--------------+   Gateway WS   +---------------------+   WS (kind 1059)   +---------+
|  #general    | <------------> |  discord adapter    |                    | relay 1 |
|  (webhook)   |   REST/webhook |         |           | <----------------> | relay 2 |
+--------------+                |  core: router,      |                    | ...     |
                                |  transform, mapping |                    +---------+
                                |         |           |
                                |  concord adapter    | --- Blossom upload --> blossom
                                |  (headless client)  |
                                +---------+-----------+
                                          |
                                     SQLite/Postgres
                              (mappings, keys, cursors, config)
```

One Node/TypeScript process (matches Armada's stack so we can reuse its protocol
code), three modules:

1. **concord adapter**: a headless Concord client. Ported/extracted from
   `armada/src/concord-v2/lib/` (`stream.ts`, `derive.ts`, `chat.ts`, `control.ts`,
   `guestbook.ts`, `invite.ts`, `rekey` handling). These files are pure protocol
   logic with little React coupling; the hooks (`useChannel2.ts` etc.) show exactly
   how to drive them (publish path `useChannel2.ts:666`, subscribe filter
   `useChannel2.ts:72`).
2. **discord adapter**: discord.js (or a thin gateway client) + webhook manager.
3. **core**: bidirectional router, content transformer, identity manager, persistent
   mapping store.

### Identity mapping

**Discord user -> Concord (puppets).** Follow Mostr's pattern: derive one Nostr
keypair per Discord user deterministically:

```
puppet_sk = HKDF-SHA256(ikm = bridge_master_secret,
                        info = "bridge/puppet" || discord_user_id)
```

- Nothing per-user is stored; keys are recomputed and LRU-cached. The master secret
  is the crown jewel (custody of every puppet), keep it in proper secret storage.
  Scope it **per bridge**, not per deployment: the hosted portal generates one
  master secret and one primary nsec per bridge, so compromising or deleting one
  tenant never touches another.
- Each puppet signs its own `20013` seals, so Armada shows real per-user authorship,
  profile, and working moderation (a Concord mod can ban one Discord user's npub
  without killing the bridge).
- Publish a kind `0` profile per puppet (Discord display name, avatar URL, and an
  `about` marking it as bridged) to the community + app relays; refresh on
  `GUILD_MEMBER_UPDATE`.
- Publish a kind `3306` guestbook join the first time a puppet speaks (cleaner than
  relying on the "observably present" rule).
- The bridge also has a **primary identity** (its own configured nsec): it is the
  actual invited member, publishes the kind 10304 bot manifest, and receives rekey
  blobs. Key material (community_root, channel keys, epochs) is fanned out to puppets
  internally: a Refounding rotator will not know to include puppet npubs, so only the
  primary can be relied on to receive new keys.

**Concord user -> Discord.** No accounts needed: the channel webhook posts with the
Concord member's display name (from their kind 0, fetched via app relays) and avatar.
Fallback: shortened npub.

### Message mapping store (persistent, not in-memory)

revcord loses edit/delete correlation on every restart because it maps in memory.
Do what matrix-appservice-discord does: a DB table per direction.

```
messages(discord_msg_id, discord_channel_id,
         concord_rumor_id, concord_channel_id, community_id,
         author_kind, created_at)
channel_links(discord_guild_id, discord_channel_id, webhook_id, webhook_token,
              community_id, concord_channel_id, enabled)
cursors(...)          -- last seen per relay/channel for backfill-free restarts
communities(...)      -- invite-derived key material, encrypted at rest
```

SQLite (better-sqlite3) for the single-tenant/self-host case. Keep the schema
Postgres-compatible: the hosted portal (`armada-bridge-portal-PLAN.md`) runs
Postgres with a `tenant_id` on every table from day one.

### Loop prevention (two layers, per Mostr)

1. Every bridge-published Concord rumor carries a tag
   `["proxy", <discord_message_id>, "discord"]`; any incoming rumor with a `proxy` tag
   is never re-bridged. Symmetrically, ignore any Discord `MESSAGE_CREATE` whose
   `webhook_id`/`application_id` is the bridge's own.
2. Belt-and-suspenders: drop any incoming Concord rumor whose author pubkey is in the
   puppet set (recomputable, plus the messages table).

---

## 3. Feature mapping table

| feature | Discord -> Concord | Concord -> Discord |
|---|---|---|
| text message | puppet-signed kind 9 | webhook post w/ name+avatar |
| reply | kind 9 + `q` tag (or 1111 if target was a thread msg) | webhook post quoting via message link / embed |
| edit | kind 3302 (provisional!) | webhook PATCH own message |
| delete | kind 5 from the puppet | webhook/bot DELETE |
| reaction | kind 7 from puppet | bot adds reaction (unicode only; custom Concord emoji -> fallback text or skip) |
| attachment | download from Discord CDN -> upload to Blossom -> `imeta` tag (optionally AES-GCM encrypted) | resolve imeta (decrypt if encrypted) -> re-upload as Discord attachment (or link if >25 MB) |
| custom emoji | `<:name:id>` -> `:name:` + NIP-30 `["emoji", name, cdn_url]` tag | `:shortcode:` + emoji tag -> nearest Discord emoji or `:shortcode:` text |
| mention | `<@id>` -> `nostr:nprofile` of puppet + `p` tag | `nostr:npub...` -> plain `@name` text (never ping unless mapped) |
| typing | Discord `TYPING_START` -> ephemeral 23311 | 23311 -> `POST /channels/{id}/typing` |
| threads (Discord) | out of scope v1; flatten with a prefix | n/a |
| voice | **out of scope** (CORD-07 E2EE SFU vs Discord voice: no sane mapping) | same |

Content transforms both directions: Discord markdown <-> Armada's markdown subset
(`renderInlineMarkdown` conventions), 65,535-byte cap on the Concord side, 2,000-char
split on the Discord side (split messages must map N Discord ids -> 1 rumor id and
vice versa in the DB).

---

## 4. Provisioning flow (two-sided handshake)

Unilateral bridging invites channel hijacking; matrix-appservice-discord's confirm
step is the right model.

Two frontends drive this same flow: slash commands or a config file for
self-hosted deployments (the steps below), and the hosted portal wizard
(`armada-bridge-portal-PLAN.md`). Both converge on step 4's in-channel confirm,
which no frontend can bypass.

1. Discord admin adds the bot (OAuth2 URL with `bot` scope; permissions: Manage
   Webhooks, Send Messages, Add Reactions, Read Message History).
2. Discord admin runs `/bridge link <armada-invite-url>` in the target channel. The
   invite URL is a normal Armada invite (naddr locator + secret fragment token).
3. The bridge joins the Concord community with its primary identity (fetch + decrypt
   the 33301 bundle, validate `community_id`, publish 3306 join), then posts a
   confirmation request into the chosen Concord channel.
4. A Concord member holding `MANAGE_CHANNELS` (or the owner) confirms with a
   `/bridge confirm <code>` command (the kind 10304 manifest advertises it). Only
   then does `channel_links` flip to enabled.
5. `/bridge unlink` on either side disables the pair; a Concord Ban of the primary
   identity or a Refounding without it severs everything automatically.

---

## 5. Implementation phases

### Phase 0: extract the protocol core
1. New repo scaffold: TypeScript, Node 22, vitest, Dockerfile, config via env.
2. Vendor/extract `armada/src/concord-v2/lib/` into a `concord-core` package: strip
   React deps, keep `stream.ts`, `derive.ts`, `chat.ts`, `control.ts`,
   `guestbook.ts`, `invite.ts`, kinds/types. Upstream this as a shared package later
   so Armada and the bridge cannot drift apart.
3. Golden tests: decrypt fixtures captured from a real Armada community (wrap ->
   seal -> rumor round-trips, control folding, timestamp math).

### Phase 1: headless Concord client
1. Relay pool (reuse Nostrify, which Armada already uses) with per-relay reconnect,
   NIP-42 auth, and cursor persistence.
2. Join-from-invite; store key material encrypted at rest.
3. Standing subscription `{kinds:[1059], authors:[derived pks]}` across all planes;
   fold control state (channels, roles, Banlist), guestbook, and chat timelines.
4. Rekey/refounding handling: subscribe rekey addresses, verify `prevcommit`
   continuity, roll epochs. Alert loudly (ops metric + Discord DM to admin) if a
   rekey arrives that excludes the primary key.
5. Publisher: build rumor with `channel`/`epoch`/`ms`/`proxy` tags, seal with a given
   signer, wrap with current epoch stream key, broadcast to all community relays
   (success = any accept), retry queue for relay flaps.

### Phase 2: Discord client + one-way D->C text
1. Gateway connection with identify/heartbeat/resume, intents as listed above.
2. Puppet manager: HKDF derivation, kind 0 publishing, 3306 join on first message.
3. `MESSAGE_CREATE` -> transform -> puppet kind 9 publish; mapping row written.
4. Loop guards in place from day one.

### Phase 3: one-way C->D text
1. Webhook manager: create/find `armada-bridge` webhook per linked channel, store
   id+token.
2. Chat rumor -> resolve author kind 0 -> webhook post; mapping row written.
3. Message splitting >2,000 chars; Banlist respected (never bridge banned authors).

### Phase 4: fidelity
1. Replies both ways (via the mapping table; `q`/1111 tags on the Concord side,
   reply-embed on the Discord side).
2. Edits (`MESSAGE_UPDATE` <-> kind 3302; keep behind a config flag until CORD
   freezes 3302) and deletes (`MESSAGE_DELETE` <-> kind 5; Concord mod deletes ->
   Discord delete needs the bot's Manage Messages permission).
3. Reactions both ways, with the custom-emoji fallbacks from the table.
4. Attachments: CDN download -> Blossom upload (BUD-02, mirror per BUD-04) with
   imeta; reverse path decrypts encrypted media and re-uploads to Discord. Size
   caps and MIME allowlist.
5. Mentions and custom emoji transforms.

### Phase 5: provisioning, ops, hardening
1. `/bridge link|confirm|unlink|status` slash commands + kind 10304 manifest.
2. Self-throttling (token bucket per direction per channel), webhook 429 backoff,
   gateway resume correctness under chaos testing.
3. Metrics (bridged counts, lag, relay health, epoch number), structured logs,
   health endpoint, Docker compose deployment, secret management for the
   per-bridge master secret and primary nsec.
4. Abuse controls: per-Discord-user mute list, max message rate, drop-and-log on
   oversized/invalid content.
5. Portal readiness: drive bridge lifecycle (create, pause, unlink, status)
   through an internal control interface instead of startup config, so the portal
   control plane (portal plan, phase A) can adopt this service without a rewrite.
   Postgres migration, typing indicators, and multiple channel pairs ride along
   here as stretch goals.

---

## 6. Risks and open questions

1. **kind 3302 (edits) is not frozen** in the CORDs. Ship edits behind a flag;
   coordinate with Armada/Vector before enabling by default.
2. **Refounding severance is by design.** If the community refounds without the
   bridge's primary npub, the bridge is out; that is the moderators' kill switch and
   we should document it as such, not fight it.
3. **E2EE boundary honesty.** Bridged messages leave the Concord encryption envelope
   and land on Discord's servers in plaintext. The confirmation step (section 4) is
   the consent gate; the bridge should also inject a one-time notice into the Concord
   channel when a link goes live. Consider `"bridged": true` in channel `custom`
   metadata so Armada can render an indicator.
4. **Puppet key custody.** The master secret derives every puppet key. Rotating it
   changes every puppet npub (history orphaned but readable). Acceptable for v1;
   document it. Per-bridge secret scoping (portal plan, section 6) contains the
   blast radius to one community pair.
5. **MESSAGE_CONTENT intent review** kicks in past 10,000 Discord users; fine for
   self-hosted instances, plan the application text for a hosted flagship instance.
6. **Discord threads and forum channels** have no Concord analogue beyond kind 1111;
   v1 flattens them. Revisit after seeing real usage.
7. **Rate/size mismatches**: 65,535-byte NIP-44 cap vs Discord embeds/attachments;
   long Discord messages with 10 attachments need deterministic fan-out rules.

---

## 7. What to build first (MVP cut)

Phases 0-3 only, config-file provisioning instead of slash commands, no edits, no
reactions, no attachments (post the Discord CDN link as text, Concord attachments as
URLs). That is a demoable two-way text bridge and validates every risky part:
protocol extraction, epochs/rekeys, puppets, webhooks, loop prevention.
