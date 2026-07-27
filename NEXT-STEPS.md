# Next steps

What is not built yet, in rough priority order. Companion to the two plan
documents (`armada-discord-bridge-PLAN.md`, `armada-bridge-portal-PLAN.md`);
this file tracks the gap between those plans and the code on `main`.

Baseline that works today: two-way text between one Discord channel and one
Armada channel per bridge, per-user attribution both ways (puppet keypairs
with kind 0 profiles / webhook personas), loop prevention, banlist
enforcement, live control-plane folds, NIP-42 stream-key relay auth, portal
wizard with Discord OAuth and the in-channel `/bridge confirm` consent gate,
per-bridge sealed secrets, Postgres mapping store.

## 1. Message fidelity

### Replies
Not bridged in either direction; a reply arrives as a bare message.
- Discord -> Concord: `MESSAGE_CREATE` with `message_reference` -> look up
  the referenced id in `messages`, attach a `q` tag (kind 9 inline quote)
  naming the mapped rumor id and author.
- Concord -> Discord: kind 9 `q` tags and kind 1111 thread replies -> look
  up the rumor id, webhook-post with an embed quoting the mapped Discord
  message (webhooks cannot use native replies; an embed with a message link
  is the standard workaround).
- The mapping store already supports both lookups (`byRumorId`; add
  `byDiscordId`).

### Edits
Not bridged. `MESSAGE_UPDATE` -> kind 3302 from the same puppet naming the
original rumor; Concord kind 3302 -> `PATCH /webhooks/.../messages/{id}`.
Ship behind a config flag: kind 3302's payload is explicitly not frozen in
the CORDs yet. Split messages need the N-rows-per-rumor mapping honored.

### Deletes
Not bridged. `MESSAGE_DELETE` -> kind 5 from the puppet (own messages only,
which holds by construction). Concord kind 5 -> webhook/bot delete of every
mapped part. Moderator deletes on the Concord side (MANAGE_MESSAGES) should
also delete on Discord; the reverse needs the bot's Manage Messages
permission and a decision about whether Discord mods may delete Armada
members' mirrored posts (recommend: yes, it only removes the mirror).

### Reactions
Not bridged. Discord `MESSAGE_REACTION_ADD/REMOVE` -> kind 7 from the
puppet (`e` target rumor, `k` "9", content = unicode emoji). Concord kind 7
-> bot `PUT /channels/.../reactions` for unicode; custom NIP-30 emoji have
no Discord equivalent, skip or fall back to a `:shortcode:` text reply.
Removal on the Concord side has no dedicated kind (kind 5 on the reaction
rumor); map both directions carefully or ship add-only first.

### Attachments
Currently flattened to CDN URLs in text. Discord attachment URLs are signed
and expire (~24 h), so links in Armada history rot.
- Discord -> Concord: download from the CDN at receive time, upload to
  Blossom (BUD-02, mirror per BUD-04), optionally AES-256-GCM encrypt the
  blob Armada-style (`encryption-algorithm`/`decryption-key`/
  `decryption-nonce` in imeta), attach NIP-92 `imeta` tags to the rumor.
- Concord -> Discord: resolve imeta, decrypt if encrypted, re-upload as a
  webhook file attachment (<= 25 MB) or fall back to the URL.
- Needs: size caps, MIME allowlist, a Blossom server config knob, and
  rate limiting on the download path.

### Mentions, emoji, formatting polish
- Concord -> Discord: `nostr:npub...` mentions of puppet identities could
  resolve back to real `<@id>` pings (reverse puppet lookup is already
  possible via the derivation); everyone-mention mapping deliberately off.
- Discord -> Concord: custom emoji currently flatten to `:name:`; could
  carry NIP-30 `emoji` tags pointing at the Discord CDN image.
- Markdown edge cases (code fences split across the 2,000-char boundary,
  spoilers, block quotes) need a fidelity pass with real corpus samples.

### Typing indicators
Ephemeral kind 23311 <-> Discord `TYPING_START` / `POST /typing`. Low value,
cheap to add, needs the ephemeral 21059 wrap path (core supports it).

## 2. Protocol robustness (the dangerous gaps)

### Rekey / refounding rollover
The biggest correctness gap. The client folds control state live but does
NOT subscribe to the precomputed rekey addresses (`concord/rekey-pseudonym`),
does not verify `prevcommit` continuity, and does not roll epochs at
runtime. Today a rekey mid-flight silences the bridge until restart, and a
Refounding severs it permanently unless the rotator included the bridge's
primary npub (which is by design the community's kill switch, but the
SURVIVABLE rekeys must be survived). Core has the pieces (`rekey.ts`:
`parseRekey`, `groupRotations`, `checkContinuity`, locators); the client
needs the subscription, key rollover, re-derivation of stream keys, and
re-registration for NIP-42 auth. Detect exclusion and mark the bridge
`severed` with the honest "community revoked access" copy.

### Cursor persistence and backfill
The `cursors` table exists but nothing writes it. On restart the bridge
relies on live subscriptions only: messages sent while it was down are
lost. Persist per-(stream, relay) high-water marks, and on boot run a
bounded backfill (paginate `until`/`limit`) through the router with the
mapping table deduplicating.

### Delivery guarantees
`sendChat` is fire-and-forget past the any-accept broadcast; a Discord
message that fails to publish is dropped with a log line. Add a retry queue
(Postgres-backed outbox per direction) so relay flaps and Discord 5xx/429
responses do not lose messages, with poison-message capping.

### Guestbook joins for puppets
Puppets appear in the member list only after speaking. Publish a kind 3306
join on first message (planned, unimplemented); consider a leave when the
Discord member leaves the guild (`GUILD_MEMBER_REMOVE`, needs the
GUILD_MEMBERS privileged intent, so make it optional).

### Dissolution handling
Kind 3308 vsk 10 (community dissolved) is not watched; the bridge should
sever itself and say why.

## 3. Discord-side gaps

- Gateway resilience: discord.js reconnects, but there is no
  alerting/self-heal when the session dies permanently (token reset,
  intent revoked). Health state should reach the portal dashboard.
- Threads and forum channels: v1 ignores messages in threads entirely
  (`ChannelType.GuildText` only). Minimum: flatten thread messages with a
  prefix; real mapping needs a design pass.
- Multiple channel pairs per guild/community: the schema supports it, the
  portal wizard and manager assume one pair per bridge.
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
- The bot manifest (kind 10304) advertising `/bridge confirm` to Armada
  clients: unpublished, so the command is discoverable only via the posted
  message text.

### Frontend: on-brand with Armada
The portal SPA is a generic placeholder; it should read as an Armada
companion tool. Brand source of truth is the Armada client itself
(soapbox.pub's Armada repo; local clone at `../armada`):
- Adopt the "Corsair" theme system from `armada/src/themes.ts`: three core
  HSL colors (near-black violet background `~260deg`, violet-ink/parchment
  foreground, electric rose-magenta primary `330 80% 52%`) with the full
  token set (`chrome`, `chromeDeep`, `chromeDivider`, phosphor-cyan
  `accent2`) derived via `deriveTokensFromCore`. Light + dark.
- Adopt the two-radii posture from `armada/src/index.css`: `--radius:
  0.75rem` for content surfaces ("the people"), `--radius-chrome: 3px` for
  structural chrome ("the hull").
- Use Armada's logo/mark assets (`armada/public/logo*.svg`) in the header
  and favicon; wizard and dashboard should visually echo Armada's
  chrome/rail framing rather than a plain centered card.
- Rewrite portal copy in Armada's voice; the wizard's Discord-purple-ish
  default styling goes.

### UX: more features and control
The dashboard is read-mostly today; give operators real controls:
- Pause/resume a bridge without deleting it, and one-way modes
  (Discord -> Armada only, or the reverse).
- Wire the stored `options` jsonb into the wizard and a per-bridge
  settings page (edits/reactions/attachments/typing toggles, once those
  features exist), plus rename the bridge and set its bot avatar.
- Live activity view: recent bridged messages, per-direction counters,
  relay connectivity, last-event timestamps (pairs with the metrics work
  in section 5).
- Manage multiple channel pairs per bridge from the dashboard (schema
  already supports it; see section 3).
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
  strfry with AUTH would catch the NIP-42 class of bug that shipped).
- No end-to-end test of the confirm flow (manager is only exercised live).
- Discord adapter is untested (needs a gateway mock or thin-slice tests of
  `toInbound`/`sanitizeUsername`, which are pure).
- Load test: one busy Discord channel (10 msg/s bursts) against relay
  publish latency.

## Suggested order

1. Rekey rollover + cursors/backfill + outbox (section 2): correctness
   before features; everything else builds on a bridge that cannot silently
   lose messages or die mid-epoch.
2. Replies, deletes, reactions, then edits-behind-flag (section 1): the
   visible fidelity gaps users hit daily.
3. Attachments via Blossom (section 1): kills the expiring-CDN-link wart.
4. Portal options wiring + severance detail + webhook recreate (sections 3
   and 4): makes the portal trustworthy for non-authors.
   Fold in the Armada rebrand and dashboard controls (section 4 frontend/UX
   subsections) here; the settings surface and the options wiring are the
   same screen.
5. Ops pass (section 5) before inviting anyone else to the hosted instance.
