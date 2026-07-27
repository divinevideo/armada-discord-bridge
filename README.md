# armada-discord-bridge

A standalone service that bridges messages between a Discord channel and an
Armada (Concord protocol) community channel, in both directions, with per-user
attribution on both sides. Built to lower the barrier of entry into Armada:
a Discord community can talk with its Armada counterpart before members migrate.

## Status

Phase 0 in progress. `packages/concord-core` is the headless Concord protocol
core (CORD-01..07) extracted from Armada's `src/concord-v2/lib`: key
derivation, gift-wrap stream handling, control-plane folding, guestbook,
invites, rekeys, with Armada's own protocol tests passing under `bun test`
(installs via npm; Bun's installer has a resolver issue on some networks).

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
