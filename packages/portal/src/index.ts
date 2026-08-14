/**
 * Portal server: JSON API + static SPA, one Bun process. In dev, run the
 * Vite dev server alongside (`bun run --cwd packages/portal web`) which
 * proxies /api here; in prod this serves web/dist directly.
 */

import { randomBytes } from "node:crypto";
import { migrate } from "@armada-bridge/bridge/src/db/migrate";
import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import postgres from "postgres";

import { Sessions, requireSession } from "./auth";
import type { SessionData, SessionGuild } from "./auth";
import {
  botGuildTextChannels,
  botInstallUrl,
  canManage,
  exchangeCode,
  fetchMe,
  fetchMyGuilds,
  oauthUrl,
} from "./discordRest";
import type { OAuthGuild } from "./discordRest";
import { loadPortalEnv } from "./env";
import { Importer, claimChallenge } from "./importer";
import type { ClaimBody, ConfirmBody, PrepareBody } from "./importer";
import { BridgeManager } from "./manager";
import type { BridgeRow } from "./manager";
import { claimCodeDigest, seal, unseal } from "./seal";

const env = loadPortalEnv();
await migrate(env.databaseUrl);
const sql = postgres(env.databaseUrl, { onnotice: () => {} });
const sessions = new Sessions(sql, env.sealKeyHex, env.baseUrl.startsWith("https:"));
const manager = new BridgeManager(sql, env);
/**
 * Deliberately NOT awaited. `init()` resumes every active bridge serially, and
 * each resume folds that community over its relays — so a single unreachable
 * relay used to leave the process alive with the Discord gateway connected but
 * the HTTP port never bound, because the default export is only evaluated once
 * the module's top-level awaits settle. The API must come up regardless;
 * bridges go live as they finish folding.
 */
void manager.init().catch((error) => console.error("portal: bridge resume failed:", error));
const importer = new Importer(sql, env, manager);

const app = new Hono();
const redirectUri = `${env.baseUrl}/api/auth/discord/callback`;

/**
 * CORS for allow-listed origins (the Armada client driving the import wizard
 * in-app).
 *
 * `Access-Control-Allow-Credentials` is deliberately absent: cookies must never
 * ride a cross-origin request. Those callers carry an `Authorization: Bearer`
 * token instead, which the browser does not attach on its own, so an allow-list
 * entry grants the ability to *ask* with a token the user's client was given —
 * never the ability to spend a session cookie a visitor already holds.
 */
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = Boolean(origin && env.allowedOrigins.includes(origin));
  if (origin && allowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Max-Age", "600");
  }
  // Cached responses must not leak one origin's ACAO header to another.
  c.header("Vary", "Origin");
  // Every API response is session-scoped; none of it belongs in a shared cache.
  c.header("Cache-Control", "no-store");
  if (c.req.method === "OPTIONS") return c.body(null, allowed ? 204 : 403);
  return next();
});

/**
 * How long a captured guild list may keep authorising mutations before it has
 * to be re-read from Discord.
 */
const GUILD_AUTHORITY_TTL_MS = 5 * 60_000;

/** Popup handoff nonce: client-generated, so hold it to 128 bits or better. */
const CLAIM_NONCE_RE = /^[0-9a-f]{32,64}$/i;

const toSessionGuilds = (guilds: OAuthGuild[]): SessionGuild[] =>
  guilds.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : undefined,
    canManage: canManage(g),
  }));

type GuildAuthority = { ok: true; guild: SessionGuild } | { ok: false; status: 401 | 403; error: string };

/**
 * Whether this session may act on a guild — verified, not merely remembered.
 *
 * The guild list is captured at OAuth time, so on its own it would keep
 * authorising someone for the session's whole 7-day life after they were
 * demoted or removed from the server. Past {@link GUILD_AUTHORITY_TTL_MS} the
 * list is re-read from Discord with the session's own bearer and written back,
 * so the window is minutes rather than days.
 *
 * Failing to verify denies rather than falls back: a session whose bearer is
 * gone (expired, revoked, or stripped by the migration that sealed them)
 * cannot prove anything, and re-login is one click. Dev-login sessions have no
 * bearer by design and keep their fixture guilds.
 */
async function guildAuthority(c: Context, session: SessionData, guildId: string): Promise<GuildAuthority> {
  let guilds = session.guilds;
  if (!session.dev && Date.now() - (session.guildsFetchedAt ?? 0) > GUILD_AUTHORITY_TTL_MS) {
    if (!session.accessToken) {
      return { ok: false, status: 401, error: "reconnect Discord so your server permissions can be checked" };
    }
    try {
      guilds = toSessionGuilds(await fetchMyGuilds(session.accessToken));
      await sessions.update(c, { ...session, guilds, guildsFetchedAt: Date.now() });
    } catch (error) {
      console.warn(`portal: guild authority refresh failed for ${session.user.id}:`, error);
      return { ok: false, status: 401, error: "could not check your Discord permissions; sign in again" };
    }
  }
  const guild = guilds.find((g) => g.id === guildId);
  if (!guild?.canManage) return { ok: false, status: 403, error: "you do not hold Manage Server in that guild" };
  return { ok: true, guild };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

app.get("/api/auth/discord", async (c) => {
  if (!env.discordClientId) return c.json({ error: "DISCORD_CLIENT_ID not configured" }, 501);
  const state = randomBytes(16).toString("hex");
  // Popup mode: an allow-listed origin opened this window and is waiting for
  // the token. An origin that isn't allow-listed silently falls back to the
  // normal redirect flow rather than being told it was rejected.
  const requested = c.req.query("origin");
  const popupOrigin =
    c.req.query("mode") === "popup" && requested && env.allowedOrigins.includes(requested)
      ? requested
      : undefined;
  if (c.req.query("mode") === "popup" && !popupOrigin) {
    console.warn(`portal: popup auth from non-allow-listed origin ${JSON.stringify(requested ?? null)}, falling back to redirect flow`);
  }
  const nonce = c.req.query("nonce");
  // 128 bits minimum: whoever knows the nonce collects the session token, and
  // the poll that spends it is necessarily unauthenticated.
  const claimNonce = popupOrigin && nonce && CLAIM_NONCE_RE.test(nonce) ? nonce.toLowerCase() : undefined;
  await sessions.create(c, { user: { id: "", username: "" }, guilds: [], oauthState: state, popupOrigin, claimNonce });
  return c.redirect(oauthUrl(env.discordClientId, redirectUri, state));
});

app.get("/api/auth/discord/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  // The session is found by the state, not the cookie — see findByOauthState
  // for why the cookie cannot be trusted to survive the trip through Discord.
  const found = state && code ? await sessions.findByOauthState(state) : undefined;
  if (!found) {
    console.warn(`portal: oauth callback with no matching session (code=${Boolean(code)}, state=${Boolean(state)})`);
    return c.text("bad oauth state", 400);
  }
  const stored = found.data;
  const token = await exchangeCode(env.discordClientId, env.discordClientSecret, redirectUri, code as string);
  const me = await fetchMe(token);
  const guilds = await fetchMyGuilds(token);
  const data: SessionData = {
    user: {
      id: me.id,
      username: me.global_name || me.username,
      avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : undefined,
    },
    guilds: toSessionGuilds(guilds),
    guildsFetchedAt: Date.now(),
    accessToken: token,
    popupOrigin: stored.popupOrigin,
    claimNonce: stored.claimNonce,
  };
  // Rotate: the pre-auth id becomes an authenticated session, and the table
  // stores only hashes, so this is also where the token to hand back is
  // minted. When a nonce is in play the same token is sealed into the row for
  // the poller below, so both legs of the popup flow agree on one session.
  const sid = await sessions.rotate(found.sidHash, data, Boolean(stored.claimNonce));
  // Re-issue the cookie: the redirect flow's SPA needs it, and the one from
  // auth-start may be gone or belong to a newer abandoned run.
  sessions.adopt(c, sid, found.expires);
  console.log(
    `portal: oauth callback completed (popup=${Boolean(stored.popupOrigin)}, nonce=${stored.claimNonce ? `${stored.claimNonce.slice(0, 8)}…` : "none"})`,
  );

  // Popup mode: hand the token to the opener and close, instead of redirecting
  // this window to the portal SPA the user never asked for. The page carries a
  // session token in its body, so it must not be stored anywhere.
  if (stored.popupOrigin) {
    c.header("Cache-Control", "no-store");
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Discord connected</title>
<body style="font:14px system-ui;padding:2rem;text-align:center">Discord connected. You can close this window.
<script>(function(){
  try { window.opener && window.opener.postMessage(
    { type: "armada-bridge-session", token: ${JSON.stringify(sid)} },
    ${JSON.stringify(stored.popupOrigin)}); } catch (e) {}
  window.close();
})();</script>`,
    );
  }
  return c.redirect("/");
});

/**
 * Poll-side of the popup flow. The opener cannot count on the callback's
 * postMessage (Discord's COOP severs `window.opener` during the login
 * navigation), so it polls here with the nonce it minted. Pending until the
 * callback lands; the first successful claim spends the nonce.
 */
app.post("/api/auth/claim", async (c) => {
  const { nonce } = (await c.req.json().catch(() => ({}))) as { nonce?: string };
  if (!nonce || !CLAIM_NONCE_RE.test(nonce)) return c.json({ error: "nonce required" }, 400);
  const found = await sessions.findByClaimNonce(nonce.toLowerCase());
  if (!found || !found.data.user.id) {
    console.log(`portal: claim ${nonce.slice(0, 8)}…: pending (${found ? "awaiting callback" : "no session"})`);
    return c.json({ pending: true });
  }
  const { claimNonce: _spent, ...rest } = found.data;
  const token = await sessions.collectHandoff(found.sidHash, rest as SessionData);
  if (!token) {
    // The stash is single-use and the nonce is spent with it, so this is a
    // second poll racing the first, not a failure worth a session for.
    console.log(`portal: claim ${nonce.slice(0, 8)}…: already collected`);
    return c.json({ pending: true });
  }
  console.log(`portal: claim ${nonce.slice(0, 8)}…: token released`);
  return c.json({ token });
});

app.post("/api/auth/dev", async (c) => {
  if (!env.devLogin) return c.json({ error: "dev login disabled" }, 403);
  // Returns the token too, so a cross-origin client (Armada's wizard in dev)
  // can authenticate without the cookie.
  const sid = await sessions.create(c, {
    user: { id: "0", username: "dev" },
    guilds: [{ id: "0", name: "Dev Guild", canManage: true }],
    dev: true,
  });
  return c.json({ ok: true, token: sid });
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
  // This answers with the BOT's view of the guild, private channels included,
  // so it needs the same authority as acting on the guild — guild ids are not
  // secret, and any logged-in stranger could otherwise enumerate a server.
  const authority = await guildAuthority(c, session, c.req.param("id"));
  if (!authority.ok) return c.json({ error: authority.error }, authority.status);
  if (!env.discordBotToken) return c.json({ error: "bot token not configured" }, 501);
  const channels = await botGuildTextChannels(env.discordBotToken, c.req.param("id"));
  if (!channels) return c.json({ present: false, installUrl: botInstallUrl(env.discordClientId, c.req.param("id")) });
  return c.json({ present: true, channels });
});

// ── Server import ────────────────────────────────────────────────────────────

app.post("/api/imports", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const { guildId } = (await c.req.json()) as { guildId?: string };
  if (!guildId) return c.json({ error: "guildId required" }, 400);
  const authority = await guildAuthority(c, session, guildId);
  if (!authority.ok) return c.json({ error: authority.error }, authority.status);
  try {
    return c.json(await importer.preview(session.user.id, guildId));
  } catch (error) {
    return c.json({ error: String(error) }, 502);
  }
});

app.get("/api/imports/:id", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const row = await importer.get(c.req.param("id"), session.user.id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    importId: row.import_id,
    status: row.status,
    statusDetail: row.status_detail,
    plan: row.plan,
    communityId: row.community_id,
    inviteUrl: row.inviteUrl,
  });
});

app.post("/api/imports/:id/prepare", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as PrepareBody;
  try {
    return c.json(await importer.prepare(c.req.param("id"), session.user.id, body));
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

app.post("/api/imports/:id/confirm", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as ConfirmBody;
  try {
    await importer.confirm(c.req.param("id"), session.user.id, body);
    return c.json({ ok: true, status: "publishing" });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

app.post("/api/imports/:id/retry", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  try {
    await importer.retry(c.req.param("id"), session.user.id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

/** Re-run only the history backfill (recovery for the silent-skip bug). */
app.post("/api/imports/:id/rerun-history", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  try {
    await importer.rerunHistory(c.req.param("id"), session.user.id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

/**
 * Same re-run, addressed by the minted community instead of the import id,
 * so the dashboard (which only knows bridges) can trigger it.
 */
app.post("/api/communities/:communityId/rerun-history", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const [row] = await sql`
    SELECT import_id FROM imports
    WHERE owner_discord_id = ${session.user.id}
      AND plan->'checkpoints'->>'communityIdHex' = ${c.req.param("communityId")}
    ORDER BY updated_at DESC LIMIT 1`;
  if (!row) return c.json({ error: "no import found for this community" }, 404);
  try {
    await importer.rerunHistory(row.import_id as string, session.user.id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

// ── Claims ──────────────────────────────────────────────────────────────────

/** The community a /claim link points at: name, plus the caller's status. */
app.get("/api/claims/:communityId", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const [row] = await sql`
    SELECT b.community_id, MAX(b.community_name) AS community_name,
           count(m.discord_message_id) AS message_count,
           EXISTS(SELECT 1 FROM claims cl
                  WHERE cl.community_id = b.community_id AND cl.discord_user_id = ${session.user.id}) AS claimed
    FROM bridges b
    LEFT JOIN messages m ON m.community_id = b.community_id AND m.origin = 'discord' AND m.author_ref = ${session.user.id}
    WHERE b.community_id = ${c.req.param("communityId")}
    GROUP BY b.community_id`;
  if (!row) return c.json({ error: "no such community" }, 404);
  return c.json({
    communityId: row.community_id,
    communityName: row.community_name,
    messageCount: String(row.message_count),
    claimed: row.claimed,
  });
});

app.post("/api/claims", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as ClaimBody & { communityId?: string };
  if (!body.communityId) return c.json({ error: "communityId required" }, 400);
  try {
    return c.json(await importer.claim(body.communityId, session, body));
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

/**
 * Resolve a claim code into the challenge the claimant signs. Scoped to the
 * caller's own Discord account, like the claim it precedes: the challenge
 * names the Discord user it is for, and codes are public in-channel.
 */
app.get("/api/claims/:communityId/challenge", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const code = (c.req.query("code") ?? "").trim().toLowerCase();
  const [row] = await sql<{ discord_user_id: string }[]>`
    SELECT discord_user_id FROM claim_codes
    WHERE code = ${claimCodeDigest(env.sealKeyHex, code)}
      AND community_id = ${c.req.param("communityId")}
      AND discord_user_id = ${session.user.id}
      AND consumed_at IS NULL AND expires_at > now()`;
  if (!row) return c.json({ error: "that code is wrong, used, expired, or not yours; run /claim again" }, 400);
  return c.json({ challenge: claimChallenge(c.req.param("communityId"), row.discord_user_id) });
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
  const { inviteUrl, fromBridgeId } = (await c.req.json()) as { inviteUrl?: string; fromBridgeId?: string };

  // "Add channel": reuse the sealed invite from a bridge the user already owns
  // instead of demanding a fresh link for every channel of the same community.
  let invite = inviteUrl;
  if (!invite && fromBridgeId) {
    const [src] = await sql<BridgeRow[]>`
      SELECT * FROM bridges WHERE bridge_id = ${fromBridgeId} AND owner_discord_id = ${session.user.id}`;
    if (!src?.invite_url_sealed) return c.json({ error: "source bridge not found" }, 404);
    invite = unseal(env.sealKeyHex, src.invite_url_sealed);
  }
  if (!invite) return c.json({ error: "inviteUrl required" }, 400);

  const inspected = await manager.inspectInvite(invite).catch((error) => ({ error: String(error) }));
  if ("error" in inspected) return c.json(inspected, 422);

  const [row] = await sql<BridgeRow[]>`
    INSERT INTO bridges (owner_discord_id, status, invite_url_sealed, community_id, community_name)
    VALUES (${session.user.id}, 'draft', ${seal(env.sealKeyHex, invite)},
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
  const authority = await guildAuthority(c, session, body.guildId);
  if (!authority.ok) return c.json({ error: authority.error }, authority.status);

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
           b.discord_channel_name, b.concord_channel_name, b.discord_guild_name,
           b.primary_pk, b.created_at,
           (SELECT count(*) FROM messages m
            WHERE m.discord_channel_id = b.discord_channel_id
              AND m.concord_channel_id = b.concord_channel_id) AS bridged_count
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
  const owned = await ownedBridge(c, session.user.id);
  if (!owned) return c.json({ error: "not found" }, 404);
  const bridgeId = owned.bridge_id;
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

/**
 * Expired sessions were excluded from every lookup but never deleted, and
 * anyone can create a pre-auth row by hitting /api/auth/discord — so the table
 * only grew. Sweep at boot, then hourly.
 */
const sweepSessions = () =>
  void sessions.sweep().catch((error) => console.warn("portal: session sweep failed:", error));
sweepSessions();
setInterval(sweepSessions, 60 * 60_000);

console.log(`portal: listening on ${env.baseUrl}`);
export default { port: env.port, fetch: app.fetch };
