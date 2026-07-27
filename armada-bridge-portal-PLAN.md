# Bridge portal: hosted setup client for the Discord <-> Armada bridge

Companion to `armada-discord-bridge-PLAN.md`. That document specifies the bridge
service itself; this one specifies the **portal**: a hosted web app where a Discord
admin and an Armada member connect their two communities in a few minutes, no
servers, no config files, no CLI.

Target sentence: "Go to the site, click Connect Discord, paste your Armada invite,
confirm in-channel, done."

---

## 1. What changes architecturally

The single-tenant service from the first plan becomes a multi-tenant platform with a
control plane and a data plane.

```
            portal frontend (React SPA, static hosting)
                          |
                    HTTPS / JSON API
                          |
          control-plane API (Hono on Bun + Postgres)
        auth, bridge CRUD, consent state, status streaming
                          |
              work assignment (lease per community)
                          |
   +----------------------+----------------------+
   | bridge worker pool (the service from plan 1, API-driven)
   |  - one headless Concord client per bridged community
   |  - ONE shared Discord bot application, gateway sharded
   |  - Blossom upload, mapping store rows in shared Postgres
   +---------------------------------------------+
```

Concrete deltas from the single-tenant plan:

1. The service is Postgres-native already; every table gains a `tenant_id`.
2. The bridge service grows an internal REST/queue interface: create, pause,
   unlink, report status. No config files.
3. One Discord application serves all tenants. Consequences: the bot must pass
   Discord verification and MESSAGE_CONTENT privileged-intent review once it crosses
   10,000 users, and gateway sharding is mandatory at 2,500 guilds. Plan the review
   application text early.
4. Secrets: each bridge gets its own primary nsec and puppet master secret,
   generated server-side, sealed with a KMS/libsodium master key. Compromise of one
   tenant's secret must not expose another's.
5. Workers hold a lease per community (Postgres advisory lock or a small lease
   table) so exactly one worker folds a given community's control plane. Restart =
   lease re-acquired, cursors resume from DB.

---

## 2. Design brief (before any UI work)

- Mission: connect a Discord server to an Armada community in under five minutes,
  and be honest about what that means for encryption.
- Audience: Discord server admins (semi-technical, wizard-native, expect OAuth
  flows) and Armada/Nostr users (key-literate, allergic to custodial hand-waving).
- Tone: plain, technical, trust through disclosure. The E2EE tradeoff is stated on
  screen, never buried in a tooltip.
- Primary action: "Create a bridge". Everything on the landing page funnels there.
- Brand direction (to be validated against Armada's actual visual identity in
  `armada/src` before building): a harbor-master's tool, dark, dense, monospace
  accents for ids and npubs, ship/rigging motif shared with Armada's naming. No
  gradient heroes, no icon-card grids; show a real screenshot of a bridged channel
  pair side by side as the hero.
- Page story: what it does and what it costs (encryption boundary) -> connect
  Discord -> connect Armada -> confirm -> watch messages flow.

---

## 3. Setup wizard (the core product)

Five steps, one screen each, resumable (state persisted server-side so a refresh or
a "go get your Armada admin" pause loses nothing).

1. **Sign in with Discord.** OAuth2 with `identify` + `guilds` scopes. Portal lists
   only guilds where the user holds Manage Server (checked from the OAuth guilds
   payload permission bits, re-verified server-side).
2. **Install the bot.** Standard OAuth2 bot-install URL with the guild preselected
   and the exact permission set (Manage Webhooks, Send Messages, Add Reactions,
   Manage Messages, Read Message History). Portal polls until the bot appears in the
   guild, then shows the channel picker.
3. **Connect Armada.** User pastes an Armada invite URL. Recommend on-screen that
   they mint a dedicated invite for the bridge so it can be revoked independently.
   Backend fetches and decrypts the kind 33301 bundle, validates `community_id`,
   joins with a freshly generated primary identity, and returns the community name,
   icon, and channel list for pairing. The invite's secret fragment travels once
   over TLS, is used, stored sealed, and never displayed again.
4. **Pair and configure.** Map Discord channel <-> Concord channel (one pair for
   MVP, multiple later). Toggles: attachments, reactions, edits (flagged provisional
   until CORD freezes kind 3302), typing. Then the consent screen: a plain-language
   statement that bridged messages leave Concord's end-to-end encryption and land on
   Discord's servers in plaintext, with an explicit checkbox.
5. **Confirm in-channel.** The bridge posts a confirmation request with a short code
   into the chosen Concord channel. Any member holding `MANAGE_CHANNELS` (or the
   owner) replies `/bridge confirm <code>` in Armada. The portal screen live-updates
   from pending to active (SSE). This step is mandatory and cannot be bypassed from
   the portal; it is the Armada side's consent gate and prevents channel hijacking
   by someone who merely possesses an invite link.

---

## 4. Dashboard (post-setup)

MVP widgets, one page per bridge:

1. Status: active / pending / paused / severed, with cause (relay unreachable,
   banned, refounded away, Discord permissions lost).
2. Health: per-relay connectivity, current epoch, message lag, last bridged message
   in each direction.
3. Counters: messages bridged per direction (24 h / all time).
4. Controls: pause/resume, unlink (with data-deletion choice), re-run channel
   pairing, copy the bridge's npub (so Armada mods can ban or role it).
5. Alerts: email/Discord DM when the bridge is severed (a Refounding that excludes
   the bridge is the community's kill switch; the portal must report it as "the
   community revoked access", never as an error to retry).

Later: moderation tools (mute a specific Discord user's puppet, view the community
Banlist as it affects bridging), audit log, usage charts.

---

## 5. Account and permission model

1. A portal account is created on first Discord sign-in. Optionally link a Nostr
   identity later (NIP-07 extension or nostr-login signing a server challenge;
   NIP-46 bunker support as a follow-up) so Armada-side people can co-manage.
2. A bridge belongs to a workspace; managers are the creating Discord admin plus
   anyone they add (by Discord id or npub). Only managers see the dashboard.
3. Discord-side authority is re-checked at mutation time (user still holds Manage
   Server in that guild), never trusted from session state.
4. Concord-side authority lives in-protocol: the in-channel confirm (setup) and the
   Banlist/Refounding (revocation). The portal reflects it, never overrides it.

---

## 6. Security, privacy, abuse

1. Key custody: primary nsec and puppet master secret per bridge, sealed at rest,
   decrypted only inside the worker holding the lease. Unlink with "delete data"
   destroys them; puppet identities become permanently unrecoverable, and the UI
   says so.
2. Invite handling: treat the pasted invite token like a password (no logging, no
   echo in responses, single use).
3. Quotas: per-bridge message rate caps (token bucket, matching the self-throttling
   in plan 1), per-account bridge count, attachment size/MIME limits. Abuse lever:
   suspend bridge, which stops both directions instantly.
4. Data retention: message-mapping rows are ids only (no content stored), still
   pruned on a schedule; configurable retention for the audit log.
5. Legal/ToS surface: hosted service ToS, Discord developer ToS compliance
   (verification, intent review), a privacy page stating exactly what is stored
   (ids, key material, counters; never message bodies).

---

## 7. Implementation phases

### Phase A: API-ify the bridge service
1. Add `tenant_id` everywhere and the lease table (the service runs Postgres
   already).
2. Internal control API: create/pause/unlink/status per bridge; workers consume it.
3. Multi-community worker: N concord clients in one process, shared Discord gateway.

### Phase B: control plane
1. Hono API on Bun: Discord OAuth, sessions, bridge CRUD, guild/channel
   listing proxied through the bot, invite-join endpoint, SSE status stream.
2. Secret sealing, quotas, permission re-checks.

### Phase C: portal frontend
1. React + Vite SPA (mirror Armada's stack and reuse its Tailwind theme tokens for
   brand consistency), five-step wizard, resumable state.
2. Dashboard page with the MVP widgets and controls.

### Phase D: consent loop and status truth
1. In-channel confirm flow wired end to end (portal pending -> Armada confirm ->
   active, over SSE).
2. Severance detection surfaced correctly (ban, refounding, relay death, Discord
   kick each get a distinct status and copy).

### Phase E: launch hardening
1. Discord bot verification + privileged intent application.
2. Alerts, retention jobs, rate/abuse tooling, ToS and privacy pages.
3. Self-host parity: one Docker compose that runs portal + API + worker with your
   own Discord application credentials, so nobody is forced onto the hosted
   instance.

---

## 8. Open questions

1. Hosting home: `bridge.armada.buzz` next to the existing AV broker, or a neutral
   domain? Affects the Discord application branding and verification.
2. Free tier limits vs paid tiers (bridges per account, message volume), if any.
3. Should the Armada-side confirm also be doable from the portal via Nostr login by
   a member who provably holds `MANAGE_CHANNELS`? Convenient, but the in-channel
   message is more visible to the community; MVP keeps in-channel only.
4. Multiple Discord guilds bridged to one Concord community (and the reverse):
   allowed in v1 or gated?
5. How the portal discovers Armada channel display names for private channels the
   bridge was not invited to: it cannot, and the pairing UI must only list channels
   whose keys the invite delivered.
