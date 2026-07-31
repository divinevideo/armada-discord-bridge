# Plan: import a Discord server as a new Armada community

Status: draft for review. Nothing here is built.

Goal: a Discord server admin runs a portal wizard and gets a brand-new Armada
community whose structure mirrors their guild: channels, community settings
(name, icon, description), roles with mapped permissions, and live bridging on
every imported channel so the two sides stay in sync from day one. Structure
first; message history and member import are explicitly out of scope for v1.

## 1. What the research found

### 1.1 The bridge today

- Armada speaks Concord (CORD-01..07): every durable event is a kind 1059
  gift wrap, and community structure lives on an encrypted control plane as
  versioned editions (kind 3308, sub-kinded by `vsk`: 0 metadata, 1 role,
  2 channel, 3 grant, 4 banlist, 8 invite registry).
- Everything the import needs to write already exists in `concord-core`:
  `mintCommunity` (`packages/concord-core/src/community.ts:30`), the edition
  builders `buildMetadataEdition` / `buildRoleEdition` / `buildChannelEdition`
  / `buildGrantEdition` / `buildBanlistEdition` (`control.ts:164-201`),
  `sealEdition` (`control.ts:90`), and the invite minting in `invite.ts`.
  `mintCommunity` is called only from tests today; the import feature would be
  the first production writer of control-plane editions.
- The portal (Hono API + React wizard, Postgres, secrets sealed under
  `PORTAL_SEAL_KEY`) currently only joins existing communities: OAuth, pick a
  guild channel, paste an Armada invite, in-channel `/bridge confirm`.
  One bridge row per channel pair in the `bridges` table.
- Concord's permission model (`roles.ts`): READ access is key possession
  (never a permission bit); WRITE authority is rank. Nine permission bits,
  roles have a position (lower outranks, owner is implicit 0), server or
  channel scope, and a color. Hard caps: 100 roles per community, 64-byte
  names.
- Every Concord channel is voice-callable (call keys derive from the channel
  stream, `community.ts:78`), which gives Discord voice channels a natural
  landing spot.

### 1.2 Discord API surface

- A plain bot install with the non-privileged `GUILDS` intent can read the
  entire structure: guild object (name, icon, description, verification
  level, system/rules channels, features), all channels with types,
  positions, `parent_id`, permission overwrites, and forum tags
  (`GET /guilds/{id}/channels`), all roles with permission bitfields inline
  on the guild object, plus emojis, stickers, welcome screen, onboarding.
- Gated data: member list needs the Server Members privileged intent;
  message content needs the Message Content privileged intent plus
  `READ_MESSAGE_HISTORY`; integrations (the guild's other bots) need
  `MANAGE_GUILD`; webhooks need `MANAGE_WEBHOOKS`; bans need `BAN_MEMBERS`.
- Overwrites are `{ id, type: role|member, allow, deny }` BigInt bitfields
  per channel. Categories are "synced" copies, never true inheritance.
- Rate limits are a non-issue for a structure snapshot: one guild is a
  handful of REST calls under the 50 req/s global cap.

### 1.3 Prior art

- GameVox (live, public beta) has the richest import: OAuth + bot, imports
  channels/categories/roles/overrides/emoji/assets, with a preview-with-counts
  screen and a live progress bar. No messages, no members.
- Guilded imports via a Discord server template link: channels, roles,
  matching permissions; one-shot, additive, non-undoable, unmapped settings
  silently dropped.
- Nobody consumer-grade imports message history (Discord has no export API;
  history means crawling) and nobody imports members (Discord exposes no
  emails). Zulip's trick for identity: let members log in with Discord OAuth
  so they arrive as themselves. Our puppet system already solves this for
  bridged traffic.
- The proven UX everywhere: authorize, pick server, preview with counts,
  confirm, progress, summary of what was and was not imported.

## 2. Design decisions (please review)

### D1. Ownership: the USER's real key owns the community (revised)

Originally this plan proposed a portal-custodied owner key; that was rejected
in review — the community must belong to the user's real Armada account.
`mintCommunity` bakes the owner pubkey into the self-certifying `community_id`
forever, and only the owner (or an outranking role holder) can sign control
editions, so the shipped design splits authority:

- The wizard has Armada-style key login (paste an nsec, unlocked and used
  only inside the browser; or a NIP-07 extension). The user's pubkey becomes
  the community owner, position 0, supreme.
- The portal prepares four seal TEMPLATES the owner signs in the browser:
  the stock Admin role edition, a grant handing that role to the portal's
  OPERATIONAL key, the owner's public-invite registry edition, and the
  owner's guestbook join. Control seals are plaintext (CORD-02 §5), so the
  templates are deterministic and verifiable server-side against the
  returned signatures.
- The operational key (sealed under `PORTAL_SEAL_KEY`) publishes everything
  else — metadata, channels, imported roles — each edition citing the
  owner-signed grant (`vac`, CORD-04 §5). The owner can revoke the grant
  from Armada at any time; the portal holds authority, never identity.

### D2. Scope: structure + live bridge, no history, no members

Matches what every shipping competitor does, and the bridge's existing
strengths cover the gap: imported channels get bridge links immediately, so
Discord members appear as puppets with profiles as soon as they speak. "Import
bots" resolves the same way: other Discord bots cannot run on Armada, but
their messages flow through the bridge as puppets like any other member, and
Concord already publishes kind 0 bot profiles.

History backfill is a separate future feature (needs the Message Content
intent crawl and cursor/backfill work already tracked in NEXT-STEPS.md).

### D3. Mechanism: live bot API, skip the template-link option

Guilded's template-link import needs no bot, but we already require the bot
for bridging, and templates omit icons, positions of overwrites, and
everything else we want. One mechanism, the bot we already have.

### D4. Auto-activate bridges, skip the consent handshake

Today's `/bridge confirm` exists to prove an Armada-side moderator consents.
For an imported community the portal is the owner, so consent is implicit.
Imported bridges go straight to `active`.

## 3. Structure mapping

| Discord | Armada / Concord | Notes |
| --- | --- | --- |
| Guild | Community (`mintCommunity` + vsk 0 metadata edition) | name, description. Icon skipped in v1: Concord icons are encrypted blob pointers (url+key+nonce+hash), which the bridge's plaintext Blossom rehosting cannot produce |
| Text channel | Channel (vsk 2 edition), public | |
| Announcement channel | Channel, public | becomes a normal channel |
| Voice / stage channel | Channel, public | decided: imported as an empty room with a `-voice` name suffix (dropped if the name already ends in "voice"), plus `custom.kind = "voice"` so future clients can render it properly |
| Category | Not supported yet | decided: recorded in `ChannelMetadata.custom.category` so today's imports stay lossless when clients grow category support; no rendering in v1 |
| Private channel (@everyone denied VIEW_CHANNEL) | Skipped in v1 | decided: not supported; preview and summary list each skipped private channel by name |
| Forum, media, threads | Skipped in v1 | bridge only handles `GuildText`; listed in the preview as skipped |
| Role | Role (vsk 1 edition) | see permission map below; positions preserved by rank order, colors carried over |
| Role count > 100 | Truncated | keep roles that carry mapped permissions or hoist, highest first; preview shows what was cut |
| Managed roles (bot roles, booster) | Skipped | identified via `role.tags` |
| Channel permission overwrites | Best effort | channel-scoped roles for channels with distinct moderation; read-visibility restrictions (the @everyone VIEW_CHANNEL deny) make a channel private, which v1 skips |
| Bans | Skipped in v1 | banlist edition exists, but bans reference members we do not import; revisit with member import |
| Emoji, stickers, soundboard | Skipped | no protocol support (MANAGE_EMOJI bit is reserved, unimplemented) |
| Onboarding, welcome screen, rules channel | Skipped | no equivalent; rules-channel pins as community description is a possible v2 nicety |
| Webhooks, integrations, audit log | Skipped | |

### Permission bit map

| Discord permission | Concord bit |
| --- | --- |
| ADMINISTRATOR | `ADMIN_ALL` |
| MANAGE_ROLES | MANAGE_ROLES |
| MANAGE_CHANNELS | MANAGE_CHANNELS |
| MANAGE_GUILD | MANAGE_METADATA |
| KICK_MEMBERS | KICK |
| BAN_MEMBERS | BAN |
| MANAGE_MESSAGES | MANAGE_MESSAGES |
| CREATE_INSTANT_INVITE | CREATE_INVITE |
| VIEW_AUDIT_LOG | VIEW_AUDIT_LOG |
| MENTION_EVERYONE | MENTION_EVERYONE |

Every other Discord bit (voice moderation, nickname management, etc.) is
dropped, and the preview says so per role. A role whose mapped bits come out
to zero is still imported if hoisted (it is a cosmetic/badge role), otherwise
skipped.

## 4. Import pipeline

Runs inside the portal process (BridgeManager sibling, `Importer`), one job
per import, resumable via a persisted plan:

1. Snapshot. REST reads: guild object (roles, emojis inline), channels,
   active threads (count only, for the "skipped" report). Normalize into an
   `ImportPlan` JSON: channels to create (public only, with category noted in
   `custom.category`), roles to create (mapped bits, position, color),
   metadata, and the skip report (private channels by name, forums, threads).
2. Preview. The plan is stored (`imports` table, status `previewed`) and
   rendered to the user with counts and the skip report. User can deselect
   channels and toggle "bridge this channel" per channel.
3. Mint. On confirm: mint owner keypair, `mintCommunity`, seal and persist
   secrets. Status `minting`.
4. Publish editions. Metadata edition, one channel edition per channel, role
   editions, admin grant for the user's npub if provided, owner guestbook
   join, then a public invite bundle (`buildBundleEvent`) so the summary
   screen has a shareable Armada invite. Each edition publish is checkpointed
   in the plan so a crash resumes instead of duplicating.
5. Wire bridges. For each channel marked "bridge": create the `bridges` row
   (status `active`), mint the per-guild puppet master secret (reusing
   `guild_community_secrets`), and hot-start the link in BridgeManager.
6. Summary. Status `done`: what was created, what was skipped and why, the
   invite link, and a copy of the admin grant npub.

Failure handling: any step failure leaves status `failed` with the checkpoint;
retry resumes. Import is one-shot per guild+community (re-running creates a
brand-new community, never mutates an old one).

## 5. Portal changes

- Wizard gets a fork at step one: "Bridge a channel" (existing) or "Import a
  server". Import path: Discord OAuth (existing) → pick a guild where the
  user has Manage Server (`canManage`, existing) → bot-install check with
  install link if absent → preview → options (npub, relay list, channel
  toggles) → confirm → progress (poll `imports` row) → summary.
- New API routes: `POST /api/imports` (snapshot+preview), `POST
  /api/imports/:id/confirm`, `GET /api/imports/:id` (progress/summary).
- New table `imports`: id, tenant, guild id, plan jsonb (with checkpoints),
  status (`previewed | minting | publishing | wiring | done | failed`),
  sealed owner secret, community id, created/updated.
- New env: `IMPORT_DEFAULT_RELAYS` (comma-separated) for the community's
  relay list, overridable in the wizard.
- Discord side needs no new intents or scopes for v1. `discordRest.ts` grows
  full-guild reads (roles, all channel types, overwrites) beyond today's
  `botGuildTextChannels`.

## 6. Out of scope for v1 (future work, in rough order)

1. Message history backfill (Message Content intent, DiscordChatExporter-style
   crawl, depends on the cursor/backfill work in NEXT-STEPS.md).
2. Member import / claimable identities (puppet keys already bridge active
   speakers; a claim flow would let a human take over their puppet).
3. Ownership handover to the user's own key.
4. Emoji once the protocol grows MANAGE_EMOJI support; forums/threads once the
   bridge handles them.
5. Continuous structure sync (Discord channel renames propagating post-import).

## 7. Open questions for review

1. Q1 (resolved, revised): the user's real key owns the community, signing
   the genesis chain in-browser per D1; the portal holds only a revocable
   Admin grant on an operational key.
2. Q2 (resolved): private channels are skipped in v1. The preview marks each
   one "will be skipped" and the summary repeats it.
3. Q3 (resolved): categories are not supported yet but wanted later, so the
   import writes `ChannelMetadata.custom.category` now and does nothing else
   with it.
4. Q4 (resolved): voice channels are imported as empty rooms with a `-voice`
   name suffix and `custom.kind = "voice"` for future client rendering.
5. Q5 (resolved, assumption): owner authority in Concord is cryptographic
   rank, never presence, so a portal-only owner is assumed fine. The import
   publishes the owner's guestbook join so member lists are coherent. Revisit
   if the client turns out to expect an online owner.

## 8. Implementation milestones

1. M1 snapshot + plan: full-guild reads in `discordRest.ts`, `ImportPlan`
   normalizer with the mapping rules above, unit tests against fixture guild
   JSON. No writes.
2. M2 minting + editions: `Importer` service, `imports` table + migration,
   edition publishing with checkpoints, against a test relay. This makes the
   bridge the first production caller of `mintCommunity`.
3. M3 wizard: portal routes + React flow (fork, preview, progress, summary).
4. M4 bridge wiring: auto-created active links, hot start, end-to-end test:
   import a fixture guild, send a Discord message, see it in Armada.
5. M5 polish: skip report copy, failure/resume paths, docs.
