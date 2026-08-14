# Next steps

What is not built yet, in rough priority order. Companion to the two plan
documents (`armada-discord-bridge-PLAN.md`, `armada-bridge-portal-PLAN.md`);
this file tracks the gap between those plans and the code on `main`.

Baseline that works today (hosted at bridge.armada.buzz): two-way text,
replies, deletes,
reactions with removal, edits behind a flag, attachments rehosted through
Blossom, GIF-picker sends resolved to real gifs (with an ffmpeg transcode
fallback), per-user attribution both ways (puppet keypairs shared per
community+guild pairing, kind 0 profiles / webhook personas), NIP-48
permalink proxy tags, loop prevention, banlist enforcement, live
control-plane folds with re-subscribe on stream-key rotation, NIP-42
stream-key relay auth including late-key re-AUTH (the silent-subscription
bug class), portal wizard with Discord OAuth, add-a-channel reuse of stored
invites, the in-channel `/bridge confirm` consent gate, sealed secrets,
Postgres mapping store, and a dashboard with per-link names and counts.

## 1. Message fidelity

### DONE: replies, edits (flagged), deletes, reactions, attachments
Shipped through `98c272c`: replies both ways (kind 9 `q` tags / jump-link
embeds, kind 1111 flattening), deletes with moderator propagation, reactions
including removal (`reaction_mappings`), edits behind `BRIDGE_EDITS` /
`options.edits`, Blossom rehosting (BUD-02, puppet-signed; live with
`BLOSSOM_SERVER=https://blossom.primal.net`), and GIF-picker resolution
(embed media swap, .gif probing, ffmpeg mp4->gif transcode + rehost).
Still open from the original attachment plan: AES-256-GCM blob encryption
Armada-style, BUD-04 mirroring, MIME allowlist, download-path rate limit.

### Mentions, emoji, formatting polish
- DONE: custom emoji round-trip. Discord -> Concord messages carry NIP-30
  `emoji` tags (CDN-backed); Concord -> Discord mirrors rewrite
  `:shortcode:` with a Discord-CDN emoji tag to native `<:name:id>` markup
  (`applyCustomEmoji`). Foreign emoji hosts stay as text shortcodes.
- Concord -> Discord: `nostr:npub...` mentions of puppet identities could
  resolve back to real `<@id>` pings (reverse puppet lookup is already
  possible via the derivation); everyone-mention mapping deliberately off.
- Markdown edge cases (code fences split across the 2,000-char boundary,
  spoilers, block quotes) need a fidelity pass with real corpus samples.

### Typing indicators (DONE)
Both directions: `TYPING_START` (GuildMessageTyping intent) -> ephemeral
kind 23311 from the puppet in a 21059 wrap; incoming 23311 -> the bot's
`sendTyping`. Throttled 4s per direction key, matching Armada's publisher.

## 2. Protocol robustness (the dangerous gaps)

### Channel structure: categories, ordering, private channels (DONE 2026-08-02)
Armada 0.45.0 added role-gated Private Channels, and CORD.md added the
`armada.category` / `armada.order` channel-metadata conventions. Three
things landed here in response:
- The importer publishes the sidebar arrangement it already computed under
  the key names Armada actually reads (`custom["armada.category"].name`,
  `custom["armada.order"].position`). It had been writing bare
  `category`/`position`, which nothing reads, so every imported server
  rendered as a flat alphabetical list. Discord-only facts (topic, the
  originating channel type, the emoji-pack pointer) moved under a
  `discord.import` namespace we own instead of squatting on `armada.*`.
- Discord channels that deny @everyone VIEW_CHANNEL now import as CORD-03
  Private Channels — independent key, plus the channel-scoped Role that is
  their access list — instead of being dropped. The key goes to the OWNER
  alone, as a Direct Invite: an import has no npub for any Discord member,
  and a key in the public bundle gates nothing.
- The bridge scans its giftwrap inbox for Direct Invites at boot
  (`concord/keyIntake.ts`) and publishes a kind-10050 inbox list, so
  "add the bridge to #mods-only" in Armada works. Nothing is persisted: a
  Direct Invite is a durable relay event sealed to us, so re-scanning
  recovers it.

STILL OPEN: private channels are imported but not live-bridged (the plan
marks them `bridgeable: false` with that reason), because a rotation would
strand the bridge — see the rekey item below. The portal's pairing wizard
also can't list a private channel for a DRAFT bridge: it inspects the
invite with a throwaway key, and the bridge's real npub is not minted until
activation, so there is nothing for Armada to have granted yet.

### Rekey / refounding rollover (partially done)
DONE: chat subscriptions rebuild when the control fold shows a new stream
set (`894f21a`), and the NIP-42 late-key re-AUTH fix (`fe46162`) removed
the failure mode where every restart silently killed Armada->Discord (keys
registered after the socket's AUTH challenge were never authenticated;
freshly-created bridges only worked because the wizard pre-registered keys).
STILL OPEN: root-epoch rotations. The client does not subscribe to the
precomputed rekey addresses (`concord/rekey-pseudonym`), verify `prevcommit`
continuity, or roll root epochs at runtime, so a Refounding still severs the
bridge until relink. Core has the pieces (`rekey.ts`: `parseRekey`,
`groupRotations`, `checkContinuity`, locators). Detect exclusion and mark
the bridge `severed` with honest "community revoked access" copy.

No longer purely latent: this is what keeps imported Private Channels from
being live-bridged. Their whole point is that access is revocable, and a
revoke rotates the channel key (CORD-06 §1 works exactly this example) — a
bridge that cannot follow a rotation would go silently quiet on the channel
it was mirroring. Channel-scoped rotations matter here as much as root
ones.

### Cursor persistence and backfill (DONE, Concord -> Discord)
Chat subscriptions advance a per-stream high-water mark (wrap `created_at`,
one sentinel `relay_url = 'pool'` row since the pool merges relays), and an
active bridge runs a bounded backfill on boot (`backfillChannel`, 500-wrap
cap) through the router with the mapping table deduplicating. A channel
with no cursor starts live-only on purpose (fresh bridges must not replay
stored history into Discord). Still open: per-relay cursor granularity if
one relay lags the pool, and the Discord -> Concord direction (messages
sent in Discord while the bridge is down; needs REST catch-up like the
history importer's pagination).

### Delivery guarantees
`sendChat` is fire-and-forget past the any-accept broadcast; a Discord
message that fails to publish is dropped with a log line. Add a retry queue
(Postgres-backed outbox per direction) so relay flaps and Discord 5xx/429
responses do not lose messages, with poison-message capping.

### Guestbook joins for puppets (DONE, join side)
Each puppet publishes a kind 3306 join on its first message per run,
backdated to the message timestamp so history imports place joins
correctly. Still open: a leave when the Discord member leaves the guild
(`GUILD_MEMBER_REMOVE`, needs the GUILD_MEMBERS privileged intent, so make
it optional).

### Dissolution handling
Kind 3308 vsk 10 (community dissolved) is not watched; the bridge should
sever itself and say why.

## 3. Discord-side gaps

- Gateway resilience: discord.js reconnects, but there is no
  alerting/self-heal when the session dies permanently (token reset,
  intent revoked). Health state should reach the portal dashboard.
- Threads and forum channels: v1 ignores messages in threads entirely
  (`ChannelType.GuildText` only). Minimum: flatten thread messages with a
  prefix; real mapping needs a design pass. (Armada kind 1111 thread
  replies DO flatten to Discord with jump-link embeds already.)
- DONE: multiple channel pairs per guild/community. One bridge row per
  pair, "Add channel" reuses the stored invite (`c97cb9b`), and puppet
  master secrets are shared per (community, guild) so one Discord user is
  one npub across pairs (`3b90bd8`).
- Slash commands on the Discord side (`/bridge status`, `/bridge unlink`):
  planned as the self-host provisioning surface; nothing implemented.
- Webhook hygiene: recreate the webhook if a Discord admin deletes it
  (currently errors per message until restart).

## 4. Portal gaps

- Multi-worker data plane: everything runs in the API process; the `leases`
  table exists but is unused. Needed before more than a handful of bridges.
- Severance detection detail: ban vs refounding vs relay death vs Discord
  kick currently all collapse into one `severed` string; the dashboard copy
  should distinguish them (portal plan phase D).
- Bridge options are stored (`options` jsonb) but not read: toggles for
  edits/reactions/attachments/typing do nothing yet.
- Guild list staleness: captured at OAuth sign-in; a "refresh servers"
  button (re-run the OAuth guilds fetch with a stored refresh token, or
  just prompt re-login) would remove a support foot-gun.
- Co-managers (add by Discord id or npub), Nostr login (NIP-07 challenge)
  for Armada-side management: designed in the portal plan, absent.
- Alerts: email/DM when a bridge severs; nothing today beyond the dashboard.
- Session sweep job (`Sessions.sweep` exists, never scheduled).
- DONE: the bot manifest (kind 10304) publishes at every bridge start
  (replaceable, primary-signed), advertising `/bridge confirm`, `/claim`,
  and `/help` per the draft NIP in armada's `NIP.md`.

### Frontend: on-brand with Armada (DONE)
Shipped: Corsair theme tokens + two-radii posture throughout, crest assets,
a real landing page (hero with a platform-true mocked bridged pair, FAQ,
footer with source/Soapbox links), and dashboard cards titled by channel
pair with guild/community subtitles and per-link counts. Dark-only for now;
a light mode remains unbuilt.

### UX: more features and control
Pause/resume and per-card "Add channel" exist; still open:
- One-way modes (Discord -> Armada only, or the reverse).
- Wire the stored `options` jsonb into the wizard and a per-bridge
  settings page (edits toggle has a working backend; reactions/
  attachments/typing toggles once split out), plus rename the bridge and
  set its bot avatar.
- Live activity view: recent bridged messages, per-direction counters,
  relay connectivity, last-event timestamps (pairs with the metrics work
  in section 5).
- Group dashboard cards by community/guild once pair counts grow.
- Recovery actions: re-run invite resolution, regenerate the confirm
  code, recreate a deleted webhook, force-reconnect the gateway.

## 5. Ops and hardening

- Rate limiting: no self-throttle on either direction yet (plan section 5).
  Token bucket per channel pair; Discord 429 backoff beyond what discord.js
  provides; relay publish pacing.
- Metrics and health: no /health endpoint, no counters (bridged/s, lag,
  relay connectivity, epoch number). The dashboard's message count is a
  table COUNT(*), fine for now, wrong at scale.
- Log hygiene: structured logs, and an audit that no invite URL, token, or
  key material can reach a log line.
- Mapping-table retention: rows grow forever; add a pruning job
  (ids only, but still).
- Docker image for the portal (compose entry exists; the image builds the
  bridge only; the SPA needs `vite build` in the Dockerfile).
- Secrets: `PORTAL_SEAL_KEY` rotation story (re-seal all rows), and moving
  the dev `.env.portal` pattern to real secret storage for hosted use.
- Discord verification runway: MESSAGE_CONTENT intent review is mandatory
  past 10,000 users; draft the application text early (plan, risk 5).

## 6. Testing debt

- No integration test against a real relay (a dockerized ditto-relay or
  strfry with AUTH). The late-key AUTH bug (`fe46162`) shipped and was
  diagnosed only live; its fix (challenge replay, CLOSED retry) is itself
  untested against a real AUTH relay. Highest-value test to add.
- No end-to-end test of the confirm flow (manager is only exercised live).
- Discord adapter has thin-slice tests (`sanitizeUsername`) only; gateway
  paths and the `toInbound` embed mapping are not covered.
- Load test: one busy Discord channel (10 msg/s bursts) against relay
  publish latency.

## Suggested order (updated 2026-07-27)

1. DONE: cursors + bounded backfill, Concord -> Discord (section 2).
   Still open there: the Discord -> Concord catch-up direction.
2. Postgres outbox for both directions (section 2): relay flaps and
   Discord 429s stop dropping messages.
3. Relay integration test with AUTH (section 6): retire the risk in the
   hand-verified re-AUTH/retry code before building more on it.
4. Portal options wiring + severance detail + webhook recreate (sections
   3 and 4): the settings surface and options wiring are one screen.
5. Rekey rollover, root AND channel scope (section 2): larger design, and
   now the blocker for live-bridging the Private Channels the importer
   creates.
6. Ops pass (section 5) before inviting anyone else to the hosted
   instance. Also still open: rotate the Discord client secret + bot token
   that were exposed in a dev chat session, then update `.env.portal` on
   the host.
