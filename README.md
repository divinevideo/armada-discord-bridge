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

## Portal (local dev)

The portal (`packages/portal`) is the web setup flow: Discord OAuth, the
five-step wizard, in-channel Armada confirmation, and a dashboard. It runs
bridges in-process, so it replaces the env-provisioned service when used.

```sh
# 1. Postgres
docker compose up -d postgres

# 2. API (terminal 1)
DATABASE_URL=postgres://bridge:bridge@localhost:5432/bridge \
PORTAL_SEAL_KEY=$(openssl rand -hex 32) \
PORTAL_DEV_LOGIN=1 \
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… DISCORD_TOKEN=… \
bun run packages/portal/src/index.ts

# 3. SPA with hot reload (terminal 2), proxies /api to :8787
./node_modules/.bin/vite packages/portal/web
# open http://localhost:5173
```

Without Discord credentials, `PORTAL_DEV_LOGIN=1` lets you click through the
UI (dev login button); going live needs a real Discord application: client
id/secret for OAuth, bot token with the MESSAGE_CONTENT intent enabled.
Keep `PORTAL_SEAL_KEY` stable across restarts or existing bridges cannot be
unsealed. In production, `vite build packages/portal/web` once and the API
serves `web/dist` itself on :8787.

## Deploy (production)

The portal runs on `discord-bridge.lan` (a Proxmox LXC) as the systemd unit
`bridge-portal.service`, which is `bun run packages/portal/src/index.ts` in
`/opt/armada-discord-bridge`, reading secrets from
`/opt/armada-discord-bridge/.env.portal`. `cloudflared` fronts it and serves
`https://bridge.armada.buzz` to `127.0.0.1:8787`. SSH is root-only; the `mk`
login is not authorized on the box.

The server has no `node`/`npm` and cannot fetch the nostr `origin`, so deploys
run from a workstation checkout: build the SPA locally, ship the commit as a git
bundle and the built `dist` as a tarball, then restart the unit.

```sh
# workstation, from a clean `main`
./node_modules/.bin/vite build packages/portal/web
git bundle create /tmp/armada-main.bundle main
tar czf /tmp/portal-dist.tgz -C packages/portal/web dist
scp /tmp/armada-main.bundle /tmp/portal-dist.tgz root@discord-bridge.lan:/tmp/

# server
ssh root@discord-bridge.lan '
  cd /opt/armada-discord-bridge
  git -c safe.directory=$PWD pull --ff-only /tmp/armada-main.bundle main
  rm -rf packages/portal/web/dist
  tar xzf /tmp/portal-dist.tgz -C packages/portal/web
  systemctl restart bridge-portal.service
'
```

`web/dist` is gitignored, so it ships separately from the bundle.
`git -c safe.directory` is required because the repo reads as `UNKNOWN` owner
inside the container. When `package.json` changes, run `bun install`
(`/root/.bun/bin/bun`) on the server before the restart; it rarely does. Keep
`PORTAL_SEAL_KEY` in the server's `.env.portal` stable or existing bridges
cannot be unsealed. To roll back, `git -c safe.directory=$PWD reset --hard
<prev-commit>` and restart the unit.

The gap between plans and code is tracked in [`NEXT-STEPS.md`](./NEXT-STEPS.md).

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
