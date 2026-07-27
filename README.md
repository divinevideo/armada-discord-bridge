# armada-discord-bridge

A standalone service that bridges messages between a Discord channel and an
Armada (Concord protocol) community channel, in both directions, with per-user
attribution on both sides. Built to lower the barrier of entry into Armada:
a Discord community can talk with its Armada counterpart before members migrate.

## Status

Two-way text MVP wired (plan section 7). What runs today:

- `packages/concord-core`: the headless Concord protocol core (CORD-01..07)
  extracted from Armada's `src/concord-v2/lib`, its protocol tests passing
  under `bun test`.
- `packages/bridge`: env-provisioned single-link bridge. Discord messages
  arrive as puppet-signed kind 9 rumors (one deterministic keypair per
  Discord user); Concord messages arrive as webhook posts with the member's
  kind 0 name and avatar. Loop prevention (proxy tags + puppet identity +
  mapping rows), banlist enforcement, live control-plane folds, message
  splitting, Postgres mapping store.

Not yet: replies/edits/deletes/reactions, attachment re-hosting,
rekey/refounding rollover, slash-command provisioning, the portal.

## Run it

```sh
# .env: BRIDGE_MASTER_SECRET (openssl rand -hex 32), BRIDGE_PRIMARY_KEY (nsec),
#       BRIDGE_INVITE_URL, DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID
docker compose up --build
```

Dev loop: `npm install` (Bun's own installer hangs on some resolvers; the
runtime is still Bun), then `bun test` and `bun run packages/bridge/src/index.ts`.

The design lives in two documents:

- [`armada-discord-bridge-PLAN.md`](./armada-discord-bridge-PLAN.md): the bridge
  service itself (protocol analysis, architecture, identity mapping, feature
  mapping, implementation phases, risks).
- [`armada-bridge-portal-PLAN.md`](./armada-bridge-portal-PLAN.md): the hosted
  web portal that lets a Discord admin and an Armada member set up a bridge
  from a website, plus the multi-tenant architecture behind it.

## References

- Concord protocol specs: https://github.com/concord-protocol/concord
- Armada client: nostr://soapbox.pub/relay.ngit.dev/armada
