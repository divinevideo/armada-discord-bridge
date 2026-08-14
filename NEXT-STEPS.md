# Next steps

Open work, roughly in priority order. Everything listed here is unbuilt or
partial — what already ships is described in the README, and the design
documents this file used to track were retired once the code outgrew them
(`git log -- '*-PLAN.md'` if you want them).

Companion: [`ARMADA-ASKS.md`](./ARMADA-ASKS.md), for the friction this repo
cannot fix alone.

## Suggested order

1. **Postgres outbox, both directions.** Relay flaps and Discord 429s drop
   messages today, silently.
2. **Relay integration test with AUTH.** The late-key re-AUTH fix is
   hand-verified only, and more is being built on top of it.
3. **Portal options wiring, severance detail, webhook recreation.** One
   screen's worth of work, and the most visible gap for operators.
4. **Rekey rollover, root and channel scope.** Larger design, and the blocker
   on live-bridging imported private channels.
5. **Ops pass** before inviting anyone else onto the hosted instance.

## Protocol robustness

- **Rekey / refounding rollover.** The client never subscribes to the
  precomputed rekey addresses, verifies `prevcommit` continuity, or rolls root
  epochs at runtime, so a Refounding severs the bridge until relink. Core has
  the pieces (`rekey.ts`: `parseRekey`, `groupRotations`, `checkContinuity`,
  locators). Channel-scope rotations matter as much as root ones: a revoke
  rotates the channel key, so a bridge that cannot follow one goes silently
  quiet on the channel it was mirroring.
- **Private channels are imported but not live-bridged**, for that reason
  (the plan marks them `bridgeable: false`). The wizard also cannot list a
  private channel for a *draft* bridge: it inspects the invite with a
  throwaway key, and the bridge's real npub is not minted until activation, so
  Armada has nothing to have granted yet.
- **Dissolution.** Kind 3308 vsk 10 is not watched; the bridge should sever
  itself and say why instead of erroring per message.
- **Delivery guarantees.** `sendChat` is fire-and-forget past the any-accept
  broadcast. A Postgres-backed outbox per direction, with poison-message
  capping, would stop relay flaps and Discord 5xx/429s losing messages.
- **Catch-up gaps.** Discord → Concord has no downtime catch-up (needs REST
  pagination like the history importer). Cursors are per-pool, not per-relay,
  so one lagging relay is invisible.
- **Guestbook leaves** when a Discord member leaves the guild. Needs the
  GUILD_MEMBERS privileged intent, so it has to be optional.

## Message fidelity

- Attachment hardening: AES-256-GCM blob encryption the way Armada does it,
  BUD-04 mirroring across more than one Blossom server, a MIME allowlist, and
  a download-path rate limit.
- `nostr:npub...` mentions of puppet identities could resolve back to real
  `<@id>` pings; the reverse lookup already exists in the derivation.
  Everyone-mentions stay off deliberately.
- Markdown edge cases — code fences split across the 2,000-character
  boundary, spoilers, block quotes — need a pass against a real corpus.
- Zaps (kinds 9735/8333) arrive on bridged messages and vanish. Mirroring
  them as a Discord reaction, or a short webhook note, closes the loop
  cheaply.

## Discord side

- **Threads and forum channels are ignored entirely** (`GuildText` only).
  Flattening with a prefix is the minimum; real mapping needs a design pass
  and probably Armada-side support.
- **Slash commands** (`/bridge status`, `/bridge unlink`): planned as the
  self-host provisioning surface, nothing implemented. Commands are parsed
  from message text today.
- **Webhook hygiene**: recreate the webhook when a Discord admin deletes it,
  instead of erroring per message until restart.
- **Gateway health** (token reset, intent revoked) should reach the dashboard;
  discord.js reconnects, but a permanent death is silent.

## Portal

- **Multi-worker data plane.** Everything runs in the API process; the
  `leases` table exists and is unused. Needed beyond a handful of bridges.
- **Severance detail.** Ban, refounding, relay death, and a Discord kick all
  collapse into one `severed` string.
- **`options` jsonb is stored but barely read.** Edits have a working
  backend; reactions, attachments, and typing toggles do nothing. Wire them
  into the wizard and a per-bridge settings page, alongside rename and bot
  avatar.
- One-way modes (Discord → Armada only, or the reverse).
- Live activity view: recent bridged messages, per-direction counters, relay
  connectivity, last-event timestamps. Pairs with the metrics work below.
- Recovery actions: re-run invite resolution, regenerate the confirm code,
  recreate a deleted webhook, force-reconnect the gateway.
- Group dashboard cards by community/guild once pair counts grow.
- Co-managers (by Discord id or npub), and Nostr login (NIP-07 challenge) for
  Armada-side management.
- Alerts — email or DM — when a bridge severs. Nothing today but the
  dashboard.
- History import: surface per-channel progress and skip reasons (bot-authored,
  empty after conversion) in the dashboard rather than the logs. A silent skip
  is opaque to debug.

## Ops and hardening

- **Rate limiting.** No self-throttle in either direction: token bucket per
  channel pair, Discord 429 backoff beyond discord.js, relay publish pacing.
- **Metrics and health.** No `/health`, no counters (bridged/s, lag, relay
  connectivity, epoch). The dashboard's message count is a `COUNT(*)` — fine
  now, wrong at scale.
- **Log hygiene.** Structured logs, plus an audit that no invite URL, token,
  or key material can reach a log line.
- **Mapping-table retention.** Rows grow forever; ids only, but still.
- **Portal Docker image.** The compose entry exists but the image builds the
  bridge only; the SPA needs `vite build` in the Dockerfile.
- **Secrets.** A `PORTAL_SEAL_KEY` rotation story (re-seal every row), and
  real secret storage instead of the env-file pattern.
- **Rotate the Discord client secret and bot token** exposed in a dev chat
  session.
- **Discord verification runway.** MESSAGE_CONTENT intent review is mandatory
  past 10,000 users; draft the application text early.

## Testing debt

- **No integration test against a real relay** (dockerized ditto-relay or
  strfry, with AUTH). The late-key AUTH bug shipped and was diagnosed live;
  its fix — challenge replay, CLOSED retry — is itself untested against a
  real AUTH relay. Highest-value test to add.
- No end-to-end test of the confirm flow; the manager is exercised only live.
- The Discord adapter has thin-slice tests only; gateway paths and the
  `toInbound` embed mapping are uncovered.
- Load test: one busy Discord channel at 10 msg/s bursts against relay
  publish latency.
