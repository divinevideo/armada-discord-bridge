# armada-discord-bridge

Bridges a Discord channel and an [Armada](https://armada.buzz) (Concord
protocol) community channel in both directions, with per-user attribution on
both sides. Built to lower the barrier to entry into Armada: a Discord
community can talk with its Armada counterpart before anyone migrates.

Messages from Discord arrive in Armada signed by a puppet key derived
deterministically per Discord user, so each person keeps one stable identity
across every channel bridged between the same server and community. Messages
from Armada arrive in Discord through a webhook wearing the member's kind 0
name and avatar.

**Bridged messages leave end-to-end encryption.** Anything mirrored into
Discord is plaintext to Discord. The Armada side gates a link behind an
in-channel confirmation from someone holding Manage Channels, so a channel is
never bridged without its community's consent.

## What works

- **Text both ways**, including long-message splitting, replies, edits,
  deletes, reactions, and typing indicators.
- **Attachments**, re-hosted to a Blossom server when one is configured, with
  a CDN-link fallback.
- **Loop prevention** on three layers: proxy tags, puppet identity, and
  mapping rows.
- **Live control-plane folds** — role and ban changes on the Armada side take
  effect without a restart, and stream-key rotation re-subscribes.
- **Catch-up backfill** after downtime, from a per-channel cursor.
- **The portal** (`packages/portal`): Discord OAuth, a setup wizard, the
  in-channel confirmation, and a dashboard to pause, resume, and unlink.
- **Server import**: mint a whole Armada community from a Discord server —
  channels, roles, and grants, with genesis signed by the owner's own key in
  their browser — then backfill history.
- **`/claim`**: a Discord user connects their Armada account to their bridged
  identity, receiving their imported roles and, if they ask for it, the puppet
  key itself.

Not yet: severance detection (ban, refounding, dissolution) is partial, and
Discord-side commands are parsed from message text rather than registered as
slash commands.

## Layout

| Package | What it is |
| --- | --- |
| `packages/concord-core` | Headless Concord protocol core (CORD-01..07), no I/O. Extracted from the Armada client. |
| `packages/bridge` | The bridge itself: Discord adapter, router, puppets, transforms, Postgres mapping store. |
| `packages/portal` | Web setup flow and multi-tenant host, running bridges in-process. `web/` is its React SPA. |

The runtime is [Bun](https://bun.sh); Postgres is the only other dependency.

## Local development

```sh
npm install          # Bun's installer hangs on some resolvers; the runtime is still Bun
docker compose up -d postgres
```

Then the portal, which is the interesting path — it runs bridges in-process
and replaces the env-provisioned service below:

```sh
# API (terminal 1)
DATABASE_URL=postgres://bridge:bridge@localhost:5432/bridge \
PORTAL_SEAL_KEY=$(openssl rand -hex 32) \
PORTAL_DEV_LOGIN=1 \
bun run packages/portal/src/index.ts

# SPA with hot reload (terminal 2), proxying /api to :8787
./node_modules/.bin/vite packages/portal/web
# open http://localhost:5173
```

`PORTAL_DEV_LOGIN=1` gives you a login button that fabricates a session, so
you can click through the UI without Discord credentials. Going live needs a
real Discord application: a client id and secret for OAuth, and a bot token
with the MESSAGE_CONTENT intent enabled.

For production, `vite build packages/portal/web` once — the API then serves
`web/dist` itself. It expects a TLS-terminating proxy in front and binds
loopback by default.

### Tests

```sh
bun test                                          # unit + protocol suites
bunx tsc -b packages/concord-core                 # the repo's typecheck script
bunx tsc -p packages/portal/tsconfig.json --noEmit  # portal, separately
```

Suites that need Postgres skip themselves when `DATABASE_URL` is unreachable,
so a bare `bun test` is still meaningful.

### Configuration

Portal:

| Variable | |
| --- | --- |
| `DATABASE_URL` | **Required.** Postgres connection string. |
| `PORTAL_SEAL_KEY` | **Required.** 64 lowercase hex chars. Seals secrets at rest — see below. |
| `PORTAL_PORT` | Default `8787`. |
| `PORTAL_HOST` | Interface to bind. Default `127.0.0.1`; the compose file sets `0.0.0.0`, where the container is the boundary. |
| `PORTAL_BASE_URL` | Public origin, used for OAuth redirects and to decide whether cookies are `Secure`. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | OAuth application credentials. |
| `DISCORD_TOKEN` | Bot token. Without it, bridges cannot go live. |
| `PORTAL_DEV_LOGIN` | `1` enables the fake-session login. Never set in production. |
| `BLOSSOM_SERVER` | Attachment re-hosting target; empty leaves CDN links. |
| `INVITE_BASE_URL` | Cosmetic base for minted invite URLs. |
| `IMPORT_DEFAULT_RELAYS` | Comma-separated relays for imported communities. |
| `PORTAL_ALLOWED_ORIGINS` | Comma-separated origins allowed to drive the API cross-origin with a bearer token. Empty means same-origin only. |

The standalone single-link bridge (`packages/bridge`) is provisioned entirely
from env instead — `BRIDGE_MASTER_SECRET`, `BRIDGE_PRIMARY_KEY`,
`BRIDGE_INVITE_URL`, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_CHANNEL_ID`, `CONCORD_CHANNEL_ID` — and runs with
`docker compose --profile bridge up`.

## What the database holds

Everything sensitive in Postgres is either sealed under `PORTAL_SEAL_KEY`
(AES-256-GCM) or stored as a one-way digest, so a database-only leak — a
backup, a replica, a dump, a console someone over-shared — yields nothing
spendable.

- **Sealed:** per-bridge key material (invite, primary nsec, puppet master
  secret), an imported community's owner key, and the Discord OAuth bearer
  inside a session.
- **Digested:** session ids (SHA-256) and `/claim` codes (keyed HMAC). Both
  are bearer credentials that exist in full only in the browser, or in the
  Discord reply that carried them.
- **Never stored:** the Discord bot token, which comes from the environment,
  and webhook credentials, which are created at runtime and cached in memory.

This is defense in depth, not a boundary: the key lives in the same
environment as the process, so anything that executes code there gets both.
It bounds database exposure specifically. Rotating the key invalidates sealed
material — every bridge included — so treat it as permanent.

## Diagnostics

`scripts/probe-channel.ts` resolves a bridge's community from its sealed
invite, folds the control plane, and reads the bridged channel from each relay
separately — which is how a per-relay delivery gap becomes visible at all,
since the pool view merges them.

```sh
PORTAL_SEAL_KEY=… DATABASE_URL=… bun run scripts/probe-channel.ts <bridge-id-prefix>
```

## References

- Concord protocol specs: https://github.com/concord-protocol/concord
- Armada client: nostr://soapbox.pub/relay.ngit.dev/armada

## License

[AGPL-3.0](LICENSE)
