/**
 * Portal server: JSON API + static SPA, one Bun process. In dev, run the
 * Vite dev server alongside (`bun run --cwd packages/portal web`) which
 * proxies /api here; in prod this serves web/dist directly.
 */

import { createHash, randomBytes } from "node:crypto";
import { heapStats } from "bun:jsc";
import { chatMemoSize } from "@armada-bridge/concord-core";
import { RelayPool } from "@armada-bridge/bridge/src/concord/pool";
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
import { Importer } from "./importer";
import type { ConfirmBody, PrepareBody } from "./importer";
import { BridgeManager } from "./manager";
import type { BridgeRow } from "./manager";
import { seal, unseal } from "./seal";
import { originGuard, securityHeaders } from "./security";

const env = loadPortalEnv();
await migrate(env.databaseUrl);
const sql = postgres(env.databaseUrl, { onnotice: () => {} });
const sessions = new Sessions(sql, env.sealKeyHex, env.baseUrl.startsWith("https:"));
const manager = new BridgeManager(sql, env);
/**
 * Deliberately NOT awaited. `init()` resumes every active bridge, and each
 * resume folds that community over its relays — so a single unreachable relay
 * used to leave the process alive with the Discord gateway connected but the
 * HTTP port never bound, because the default export is only evaluated once the
 * module's top-level awaits settle. The API must come up regardless; bridges
 * go live as they finish folding, a poolful at a time (see startAll).
 */
const importer = new Importer(sql, env, manager);
void manager
  .init()
  .catch((error) => console.error("portal: bridge resume failed:", error))
  // After the bridges, whatever became of them: a resumed import's wiring and
  // history stages route through the live bridges.
  .then(() => importer.resumeInterrupted())
  .catch((error) => console.error("portal: import resume failed:", error));

/**
 * One line every ten minutes on where the memory is. The 2026-09-23 OOM left
 * nothing to tell a leak from a baseline or JS heap from native buffers; with
 * this, the journal before any kill says which one grew and alongside what.
 */
setInterval(() => {
  const m = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
  const relays = RelayPool.backlog();
  console.log(
    `portal: memory rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB external=${mb(m.external)}MB ` +
      `bridges=${manager.liveCount} imports=${importer.activeCount} chatMemo=${chatMemoSize()} ` +
      `pools=${relays.pools} sockets=${relays.sockets} down=${relays.down} ` +
      `queued=${relays.queued} unsent=${mb(relays.unsentBytes)}MB`,
  );
}, 10 * 60 * 1000).unref();

/**
 * `systemctl kill -s USR2 bridge-portal` logs the live heap by object type.
 * On demand only: the census walks the whole heap, a second or more of
 * blocked event loop at production size.
 */
process.on("SIGUSR2", () => {
  // Collect first, and report both sides: the gap between them is garbage
  // not yet collected, which the ten-minute line cannot tell from growth.
  const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
  const before = process.memoryUsage();
  Bun.gc(true);
  const after = process.memoryUsage();
  console.log(
    `portal: full gc: heap ${mb(before.heapUsed)}->${mb(after.heapUsed)}MB ` +
      `external ${mb(before.external)}->${mb(after.external)}MB rss ${mb(before.rss)}->${mb(after.rss)}MB`,
  );
  const { objectTypeCounts, heapSize, objectCount } = heapStats();
  const top = Object.entries(objectTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([type, n]) => `${type}=${n}`)
    .join(" ");
  console.log(`portal: heap census ${Math.round(heapSize / 2 ** 20)}MB, ${objectCount} objects: ${top}`);
});

const app = new Hono();
// Metrics listen on a separate, internal-only port; public portal routes expose none.
if (process.env.PORTAL_METRICS_PORT) {
  const port = Number(process.env.PORTAL_METRICS_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === env.port) throw new Error("Invalid metrics port");
  Bun.serve({ hostname: "0.0.0.0", port, fetch(request) {
    if (new URL(request.url).pathname !== "/metrics") return new Response(null, { status: 404 });
    return new Response(`armada_discord_connected ${Number(manager.discordConnected)}\narmada_relay_sockets_down ${RelayPool.backlog().down}\n`, { headers: { "content-type": "text/plain; version=0.0.4" } });
  } });
}
const redirectUri = `${env.baseUrl}/api/auth/discord/callback`;
const overHttps = env.baseUrl.startsWith("https:");

app.use("*", securityHeaders(overHttps));

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

app.use("/api/*", originGuard(env.baseUrl, env.allowedOrigins));

/**
 * How long a captured guild list may keep authorising mutations before it has
 * to be re-read from Discord.
 */
const GUILD_AUTHORITY_TTL_MS = 5 * 60_000;

/** Popup handoff nonce: client-generated, so hold it to 128 bits or better. */
const CLAIM_NONCE_RE = /^[0-9a-f]{32,64}$/i;

/**
 * How long a popup handoff stays collectable, measured from auth-start.
 *
 * The opener is polling in real time, so minutes is generous. A run that is
 * never collected currently sits there for the session's whole seven days,
 * which is seven days in which a stashed token is one leaked nonce from being
 * spent.
 */
const CLAIM_WINDOW_MS = 10 * 60_000;

/** For the one server-rendered page in the codebase (the popup callback). */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

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

/**
 * Whether this session may still act on an import: owner of the row, and still
 * holding Manage Server in the guild that import draws from.
 *
 * `POST /api/imports` establishes authority once. Every route below it used to
 * check `owner_discord_id` alone, which made that first check permanent — and
 * these are not read-only routes. `rerun-history` in particular fetches LIVE
 * Discord history with the bot token at call time, not the snapshot the plan
 * was built from, so someone since demoted or removed from a server could keep
 * pumping its fresh messages into a community they control.
 */
async function importAuthority(
  c: Context,
  session: SessionData,
  importId: string,
): Promise<{ ok: true } | { ok: false; status: 401 | 403 | 404; error: string }> {
  const [row] = await sql<{ discord_guild_id: string | null }[]>`
    SELECT discord_guild_id FROM imports
     WHERE import_id = ${importId} AND owner_discord_id = ${session.user.id}`;
  if (!row) return { ok: false, status: 404, error: "not found" };
  // An import with no guild recorded cannot be re-checked; the owner test
  // already passed, and the importer will fail on its own if it needs one.
  if (!row.discord_guild_id) return { ok: true };
  const authority = await guildAuthority(c, session, row.discord_guild_id);
  return authority.ok ? { ok: true } : { ok: false, status: authority.status, error: authority.error };
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
  // the poll that spends it is necessarily unauthenticated. Entropy is not the
  // property that matters, though — the nonce arrives in the URL, so the
  // author of that URL knows it without guessing. See the claim route.
  const claimNonce = popupOrigin && nonce && CLAIM_NONCE_RE.test(nonce) ? nonce.toLowerCase() : undefined;
  await sessions.create(c, {
    user: { id: "", username: "" },
    guilds: [],
    oauthState: state,
    popupOrigin,
    claimNonce,
    claimStartedAt: claimNonce ? Date.now() : undefined,
  });
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

  /**
   * Redirect flow: the browser finishing the login must be the one that
   * started it.
   *
   * Finding the session by `state` alone is what the popup flow needs (its
   * cookie routinely does not survive the trip through Discord), but on its
   * own it is a login-CSRF primitive: an attacker starts a run, gets their own
   * `code`, then makes a victim's browser follow the callback URL. The lookup
   * succeeds, `adopt` below plants a cookie, and the victim is now operating
   * inside the ATTACKER's Discord account — pasting their invite link, running
   * an import, linking a bridge.
   *
   * The redirect flow is exactly the case where the cookie DOES survive:
   * /api/auth/discord set it moments earlier and `SameSite=Lax` sends it on
   * this top-level GET. So require it here, and leave the state-only path to
   * the popup flow, which hands its token to an allow-listed origin instead of
   * planting a cookie (see below — `adopt` is skipped there for this reason).
   *
   * The cost, accepted knowingly: starting the login twice overwrites the
   * first run's cookie, so completing the OLDER tab now lands here and is
   * refused rather than signing in. That is one more click on Connect, and it
   * is the same trade every double-submit CSRF defence makes.
   */
  if (!stored.popupOrigin && sessions.cookieSidHash(c) !== found.sidHash) {
    console.warn("portal: oauth callback whose cookie does not match the run it completes; refusing");
    return c.text("bad oauth state", 400);
  }
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
    claimStartedAt: stored.claimStartedAt,
  };
  // The nonce poll is a bearer channel whose bearer was chosen by whoever
  // composed the auth-start URL, so the callback alone must not make the token
  // collectable: a stranger can pick a nonce, lure someone through this flow,
  // and poll for their session from anywhere. This token exists only in the
  // page below, in the browser that actually ran the login, and the click that
  // spends it is the one step that browser's owner has to take deliberately.
  const approvalToken = stored.claimNonce ? randomBytes(24).toString("hex") : undefined;
  if (approvalToken) data.claimApproval = createHash("sha256").update(approvalToken, "utf8").digest("hex");
  // Rotate: the pre-auth id becomes an authenticated session, and the table
  // stores only hashes, so this is also where the token to hand back is
  // minted. When a nonce is in play the same token is sealed into the row for
  // the poller below, so both legs of the popup flow agree on one session.
  const sid = await sessions.rotate(found.sidHash, data, Boolean(stored.claimNonce));
  // Re-issue the cookie: the redirect flow's SPA needs it, and the one from
  // auth-start may be gone or belong to a newer abandoned run.
  //
  // NOT in popup mode. That leg is the one exempted from the cookie binding
  // above, so planting a cookie here would hand the exemption a way to reach
  // a victim's browser after all — start a popup run naming an allow-listed
  // origin, complete it with your own code, then get the victim to load the
  // callback URL. The popup's caller collects its token by postMessage or the
  // nonce poll and never reads the cookie, so there is nothing to lose.
  if (!stored.popupOrigin) sessions.adopt(c, sid, found.expires);
  console.log(
    `portal: oauth callback completed (popup=${Boolean(stored.popupOrigin)}, nonce=${stored.claimNonce ? `${stored.claimNonce.slice(0, 8)}…` : "none"})`,
  );

  // Popup mode: hand the token to the opener and close, instead of redirecting
  // this window to the portal SPA the user never asked for. The page carries a
  // session token in its body, so it must not be stored anywhere.
  if (stored.popupOrigin) {
    c.header("Cache-Control", "no-store");
    // The only inline script in the codebase, so it gets a policy of its own:
    // a fresh nonce, and nothing else permitted to run.
    const nonce = randomBytes(16).toString("base64");
    // `connect-src 'self'` is what lets the Connect button reach
    // /api/auth/popup-approve; under the inherited `default-src 'none'` the
    // fetch is blocked and the button silently does nothing.
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`,
    );
    // postMessage stays unconditional and needs no confirmation: the browser
    // checks targetOrigin against the receiving window's ACTUAL origin, so a
    // hostile opener is handed nothing. It is the poll that cannot tell the
    // two apart, and only the poll is gated.
    const handoff = `try { window.opener && window.opener.postMessage(
    { type: "armada-bridge-session", token: ${JSON.stringify(sid)} },
    ${JSON.stringify(stored.popupOrigin)}); } catch (e) {}`;
    const origin = escapeHtml(stored.popupOrigin);
    if (!approvalToken) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Discord connected</title>
<body style="font:14px system-ui;padding:2rem;text-align:center">Discord connected. You can close this window.
<script nonce="${nonce}">(function(){
  ${handoff}
  window.close();
})();</script>`,
      );
    }
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Discord connected</title>
<body style="font:14px system-ui;padding:2rem;text-align:center">
<p>Connect your Discord account to <b>${origin}</b>?</p>
<p style="color:#666">Only do this if you started this login from that site.</p>
<button id="go" style="font:inherit;padding:.6rem 1.2rem">Connect</button>
<p id="msg"></p>
<script nonce="${nonce}">(function(){
  ${handoff}
  document.getElementById("go").addEventListener("click", function(){
    this.disabled = true;
    fetch("/api/auth/popup-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: ${JSON.stringify(approvalToken)} })
    }).then(function(r){
      if (!r.ok) throw new Error("failed");
      document.getElementById("msg").textContent = "Connected. You can close this window.";
      window.close();
    }).catch(function(){
      document.getElementById("msg").textContent = "Could not complete the connection.";
    });
  });
})();</script>`,
    );
  }
  return c.redirect("/");
});

/**
 * Approval side of the popup flow: the Connect button on the callback page.
 *
 * Unauthenticated by necessity — popup mode never plants a cookie — but not
 * unauthorized: the token it spends was generated by the callback and written
 * into that page and nowhere else, so possessing it means being the browser
 * that just completed the login.
 */
app.post("/api/auth/popup-approve", async (c) => {
  const { approval } = (await c.req.json().catch(() => ({}))) as { approval?: string };
  if (!approval || !/^[0-9a-f]{48}$/.test(approval)) return c.json({ error: "approval required" }, 400);
  const ok = await sessions.approveHandoff(approval);
  if (!ok) return c.json({ error: "no pending connection" }, 404);
  console.log("portal: popup handoff approved");
  return c.json({ ok: true });
});

/**
 * Poll-side of the popup flow. The opener cannot count on the callback's
 * postMessage (Discord's COOP severs `window.opener` during the login
 * navigation), so it polls here with the nonce it minted. Pending until the
 * callback lands AND the person in front of the popup has confirmed; the first
 * successful claim spends the nonce.
 *
 * The confirmation is what makes the flow safe, and it is worth being precise
 * about why nothing cheaper works. The nonce travels in the auth-start URL, so
 * its author knows it: a stranger picks a nonce, links a victim to
 * `/api/auth/discord?mode=popup&origin=<allow-listed>&nonce=…`, and polls here
 * from their own server for the session that victim's login produced. Naming
 * an allow-listed origin is enough; controlling it is not required.
 *
 * Neither of the obvious fixes closes that. Minting the nonce server-side
 * fails because the attacker can mint one too and then send the link. Binding
 * the callback to the auth-start cookie fails because the lure makes the
 * server set that cookie in the VICTIM's browser, for the attacker's run — the
 * check passes and the poll still collects. An `Origin` requirement fails
 * because a poller that is not a browser sends whatever Origin it likes.
 *
 * What distinguishes the honest case is that the opener is running in the same
 * browser the login ran in. Proving that to the server needs a credential that
 * reaches that browser AFTER the URL was composed and travels to the opener
 * over a same-origin channel — which is a redirect back to `popupOrigin` with
 * the token in the fragment, and a matching change in the client that reads
 * it. Until that ships on both sides, the deliberate click stands in for it:
 * it cannot be performed from the attacker's server, and the page names the
 * origin being connected to.
 */
app.post("/api/auth/claim", async (c) => {
  const { nonce } = (await c.req.json().catch(() => ({}))) as { nonce?: string };
  if (!nonce || !CLAIM_NONCE_RE.test(nonce)) return c.json({ error: "nonce required" }, 400);
  const found = await sessions.findByClaimNonce(nonce.toLowerCase());
  if (!found || !found.data.user.id) {
    console.log(`portal: claim ${nonce.slice(0, 8)}…: pending (${found ? "awaiting callback" : "no session"})`);
    return c.json({ pending: true });
  }
  if (!found.data.claimApproved) {
    console.log(`portal: claim ${nonce.slice(0, 8)}…: pending (awaiting confirmation in the popup)`);
    return c.json({ pending: true });
  }
  const startedAt = found.data.claimStartedAt ?? 0;
  if (Date.now() - startedAt > CLAIM_WINDOW_MS) {
    console.warn(`portal: claim ${nonce.slice(0, 8)}…: refused, handoff window expired`);
    return c.json({ error: "handoff expired" }, 410);
  }
  // Every field the handoff used goes with it: a spent run leaves no nonce to
  // look up and no approval to re-spend.
  const {
    claimNonce: _spent,
    claimApproved: _approved,
    claimApproval: _approval,
    claimStartedAt: _started,
    ...rest
  } = found.data;
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

/**
 * Sign out everywhere: drops every session for this Discord account.
 *
 * The popup handoff releases a session token to whoever polls the nonce, and
 * plants no cookie in the browser that ran the login — so a token collected by
 * someone else names a session its owner cannot reach with /logout, which only
 * ever destroys the one presenting the request. Without this there is no way
 * to take such a session back before it expires on its own a week later.
 */
app.post("/api/auth/revoke-all", async (c) => {
  const session = await requireSession(c, sessions);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const revoked = await sessions.revokeAllForUser(c, session.user.id);
  console.log(`portal: revoked ${revoked} session(s) for one account`);
  return c.json({ ok: true, revoked });
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
  const allowed = await importAuthority(c, session, c.req.param("id"));
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
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
  const allowed = await importAuthority(c, session, c.req.param("id"));
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
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
  const allowed = await importAuthority(c, session, c.req.param("id"));
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
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
  const allowed = await importAuthority(c, session, c.req.param("id"));
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
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
  const allowed = await importAuthority(c, session, row.import_id as string);
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);
  try {
    await importer.rerunHistory(row.import_id as string, session.user.id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
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

  // Authority over `guildId` says nothing about `channelId`: a channel id is
  // not a claim about the guild it lives in, and both arrive in the same body.
  // Without tying them together, someone links a bridge naming a throwaway
  // guild they own and a channel id lifted from a server they do not — ids are
  // not secret — then confirms it from their own community, where they are the
  // owner. One shared bot serves every tenant and BridgeManager routes on the
  // channel id alone, so that mirrors a stranger's channel into their
  // community and lets them post into it through the webhook.
  if (!env.discordBotToken) return c.json({ error: "bot token not configured" }, 501);
  const guildChannels = await botGuildTextChannels(env.discordBotToken, body.guildId);
  if (!guildChannels) {
    return c.json({ error: "the bot is not in that guild" }, 409);
  }
  if (!guildChannels.some((ch) => ch.id === body.channelId)) {
    return c.json({ error: "that channel is not in that guild" }, 403);
  }
  try {
    await manager.assertPublicChannel(body.guildId, body.channelId);
  } catch {
    return c.json({ error: "Channel is excluded, private, or its public visibility could not be verified" }, 403);
  }
  // Second live bridge on one channel: last writer would win `byDiscordChannel`
  // and steal the channel from the bridge already mirroring it. A unique index
  // (migration 017) is the backstop for the race between two of these checks;
  // this is here to answer with a 409 rather than a constraint violation.
  const [taken] = await sql<{ bridge_id: string }[]>`
    SELECT bridge_id FROM bridges
     WHERE discord_channel_id = ${body.channelId}
       AND status IN ('pending_confirm', 'active')
       AND bridge_id <> ${row.bridge_id}`;
  if (taken) return c.json({ error: "that channel is already bridged" }, 409);

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

console.log(`portal: listening on ${env.baseUrl} (bound to ${env.host}:${env.port})`);
export default { port: env.port, hostname: env.host, fetch: app.fetch };
