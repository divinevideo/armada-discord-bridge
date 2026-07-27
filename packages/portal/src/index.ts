/**
 * Portal server: JSON API + static SPA, one Bun process. In dev, run the
 * Vite dev server alongside (`bun run --cwd packages/portal web`) which
 * proxies /api here; in prod this serves web/dist directly.
 */

import { randomBytes } from "node:crypto";
import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import postgres from "postgres";

import { Sessions, requireSession } from "./auth";
import type { SessionData } from "./auth";
import {
  botGuildTextChannels,
  botInstallUrl,
  canManage,
  exchangeCode,
  fetchMe,
  fetchMyGuilds,
  oauthUrl,
} from "./discordRest";
import { loadPortalEnv } from "./env";
import { BridgeManager } from "./manager";
import type { BridgeRow } from "./manager";
import { seal } from "./seal";

const env = loadPortalEnv();
await migrate(env.databaseUrl);
const sql = postgres(env.databaseUrl, { onnotice: () => {} });
const sessions = new Sessions(sql);
const manager = new BridgeManager(sql, env);
await manager.init();

const app = new Hono();
const redirectUri = `${env.baseUrl}/api/auth/discord/callback`;

// ── Auth ─────────────────────────────────────────────────────────────────────

app.get("/api/auth/discord", async (c) => {
  if (!env.discordClientId) return c.json({ error: "DISCORD_CLIENT_ID not configured" }, 501);
  const state = randomBytes(16).toString("hex");
  await sessions.create(c, { user: { id: "", username: "" }, guilds: [], oauthState: state });
  return c.redirect(oauthUrl(env.discordClientId, redirectUri, state));
});

app.get("/api/auth/discord/callback", async (c) => {
  const stored = await sessions.get(c);
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!stored || !code || !state || state !== stored.oauthState) return c.text("bad oauth state", 400);
  const token = await exchangeCode(env.discordClientId, env.discordClientSecret, redirectUri, code);
  const me = await fetchMe(token);
  const guilds = await fetchMyGuilds(token);
  const data: SessionData = {
    user: {
      id: me.id,
      username: me.global_name || me.username,
      avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : undefined,
    },
    guilds: guilds.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : undefined,
      canManage: canManage(g),
    })),
  };
  await sessions.update(c, data);
  return c.redirect("/");
});

app.post("/api/auth/dev", async (c) => {
  if (!env.devLogin) return c.json({ error: "dev login disabled" }, 403);
  await sessions.create(c, {
    user: { id: "0", username: "dev" },
    guilds: [{ id: "0", name: "Dev Guild", canManage: true }],
    dev: true,
  });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  await sessions.destroy(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const session = await sessions.get(c);
  const discordConfigured = Boolean(env.discordClientId && env.discordClientSecret);
  if (!session || !session.user.id) return c.json({ user: null, devLogin: env.devLogin, discordConfigured });
  return c.json({
    user: session.user,
    guilds: session.guilds.filter((g) => g.canManage),
    devLogin: env.devLogin,
    discordConfigured,
  });
});

// ── Discord-side wizard data ────────────────────────────────────────────────

app.get("/api/guilds/:id/channels", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (!env.discordBotToken) return c.json({ error: "bot token not configured" }, 501);
  const channels = await botGuildTextChannels(env.discordBotToken, c.req.param("id"));
  if (!channels) return c.json({ present: false, installUrl: botInstallUrl(env.discordClientId, c.req.param("id")) });
  return c.json({ present: true, channels });
});

// ── Bridges ──────────────────────────────────────────────────────────────────

const ownedBridge = async (c: { req: { param: (k: string) => string } }, ownerId: string) => {
  const [row] = await sql<BridgeRow[]>`
    SELECT * FROM bridges WHERE bridge_id = ${c.req.param("id")} AND owner_discord_id = ${ownerId}`;
  return row;
};

app.post("/api/bridges", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const { inviteUrl } = (await c.req.json()) as { inviteUrl?: string };
  if (!inviteUrl) return c.json({ error: "inviteUrl required" }, 400);

  const inspected = await manager.inspectInvite(inviteUrl).catch((error) => ({ error: String(error) }));
  if ("error" in inspected) return c.json(inspected, 422);

  const [row] = await sql<BridgeRow[]>`
    INSERT INTO bridges (owner_discord_id, status, invite_url_sealed, community_id, community_name)
    VALUES (${session.user.id}, 'draft', ${seal(env.sealKeyHex, inviteUrl)},
            ${inspected.community.idHex}, ${inspected.community.name})
    RETURNING *`;
  return c.json({ bridgeId: row.bridge_id, community: inspected.community, channels: inspected.channels });
});

app.post("/api/bridges/:id/link", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await ownedBridge(c, session.user.id);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "draft") return c.json({ error: `bridge is ${row.status}, not draft` }, 409);

  const body = (await c.req.json()) as {
    guildId?: string;
    channelId?: string;
    concordChannelId?: string;
    consent?: boolean;
  };
  if (!body.guildId || !body.channelId || !body.concordChannelId) {
    return c.json({ error: "guildId, channelId, concordChannelId required" }, 400);
  }
  if (body.consent !== true) {
    return c.json({ error: "the encryption disclosure must be explicitly accepted" }, 400);
  }
  const guild = session.guilds.find((g) => g.id === body.guildId);
  if (!guild?.canManage) return c.json({ error: "you do not hold Manage Server in that guild" }, 403);

  await sql`
    UPDATE bridges SET discord_guild_id = ${body.guildId}, discord_channel_id = ${body.channelId},
      concord_channel_id = ${body.concordChannelId}, updated_at = now()
    WHERE bridge_id = ${row.bridge_id}`;
  const [fresh] = await sql<BridgeRow[]>`SELECT * FROM bridges WHERE bridge_id = ${row.bridge_id}`;
  await manager.activate(fresh);
  return c.json({ ok: true, status: "pending_confirm" });
});

app.get("/api/bridges", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const rows = await sql`
    SELECT b.bridge_id, b.status, b.status_detail, b.community_name, b.community_id,
           b.discord_guild_id, b.discord_channel_id, b.concord_channel_id, b.confirm_code,
           b.primary_pk, b.created_at,
           (SELECT count(*) FROM messages m WHERE m.community_id = b.community_id) AS bridged_count
    FROM bridges b
    WHERE b.owner_discord_id = ${session.user.id} AND b.status <> 'unlinked'
    ORDER BY b.created_at DESC`;
  return c.json({ bridges: rows, live: rows.map((r) => manager.isLive(r.bridge_id as string)) });
});

app.post("/api/bridges/:id/pause", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await ownedBridge(c, session.user.id);
  if (!row) return c.json({ error: "not found" }, 404);
  await manager.stop(row.bridge_id, "paused");
  return c.json({ ok: true });
});

app.post("/api/bridges/:id/resume", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await ownedBridge(c, session.user.id);
  if (!row) return c.json({ error: "not found" }, 404);
  await manager.resume(row.bridge_id);
  return c.json({ ok: true });
});

app.post("/api/bridges/:id/unlink", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await ownedBridge(c, session.user.id);
  if (!row) return c.json({ error: "not found" }, 404);
  await manager.stop(row.bridge_id, "unlinked", "unlinked from the portal");
  return c.json({ ok: true });
});

/** Poll-based status stream for the confirm screen. */
app.get("/api/bridges/:id/events", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const bridgeId = c.req.param("id");
  return c.body(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let last = "";
        for (let i = 0; i < 300; i++) {
          const [row] = await sql`SELECT status, status_detail FROM bridges WHERE bridge_id = ${bridgeId}`;
          const payload = JSON.stringify(row ?? { status: "gone" });
          if (payload !== last) {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            last = payload;
          }
          if (!row || row.status !== "pending_confirm") break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        controller.close();
      },
    }),
    200,
    { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  );
});

// ── Static SPA (production build) ───────────────────────────────────────────
app.use("/*", serveStatic({ root: "./packages/portal/web/dist" }));
app.get("*", serveStatic({ path: "./packages/portal/web/dist/index.html" }));

console.log(`portal: listening on ${env.baseUrl}`);
export default { port: env.port, fetch: app.fetch };
