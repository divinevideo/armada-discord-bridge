import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { Decisions } from "./decisions";
import { DiscordActions } from "./discordActions";
import { EvidenceCipher } from "./evidence";
import { migrateModeration } from "./policyStore";

const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
const org = crypto.randomUUID(), community = "6".repeat(64);
const staff = { orgId: org, actorId: "synthetic-guild-reviewer", permissions: ["view", "ban_member", "unban_member", "retry", "discord_guild_ban"] };
const moderator = { ...staff, permissions: staff.permissions.filter(p => p !== "discord_guild_ban") };
const cipher = new EvidenceCipher(randomBytes(32), 3600, 100_000);
const outbox = new Decisions(sql, cipher, new Map([[community, org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
const api = new Decisions(apiSql, cipher, new Map([[community, org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
beforeAll(() => migrateModeration(sql));
afterAll(async () => {
  await sql`DELETE FROM moderation.decisions WHERE org_id = ${org}`;
  await sql`DELETE FROM moderation.cases WHERE org_id = ${org}`;
  await apiSql.end(); await sql.end();
});
async function subject() {
  const caseId = crypto.randomUUID(), author = randomBytes(32).toString("hex");
  await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
    VALUES (${caseId}, ${org}, ${community}, ${"7".repeat(64)}, ${randomBytes(32).toString("hex")}, ${author}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
  let revision = 0;
  return (action: "ban_member" | "unban_member", guild: boolean) => api.acceptDecision({ caseId, executionId: crypto.randomUUID(), action,
    reason: "Synthetic scope ordering", scope: "community", discordGuildConfirmed: guild, sourceOrder: { version: 1, revision: String(++revision) } }, guild ? staff : moderator);
}
const park = (id: string) => sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${id}`;
const readyDiscord = (id: string) => sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() WHERE decision_id = ${id} AND target = 'discord'`;
const rows = (id: string) => sql`SELECT target, state, result_code, attempts, superseded_by FROM moderation.deliveries WHERE decision_id = ${id} ORDER BY target`;
const cleanup = (...ids: string[]) => sql`DELETE FROM moderation.decisions WHERE decision_id IN ${sql(ids)}`;

// A Discord target represents Guild intent only with explicit confirmation.
// A community-only successor must not silently erase that independent effect.
for (const older of ["ban_member", "unban_member"] as const) for (const newer of ["ban_member", "unban_member"] as const) {
  test(`community ${newer} preserves queued Guild ${older}`, async () => {
    const accept = await subject(), first = await accept(older, true), second = await accept(newer, false);
    try {
      await park(first.decisionId); await park(second.decisionId); await readyDiscord(first.decisionId);
      const claim = await outbox.claim();
      expect(claim).toMatchObject({ target: "discord", decision: { decisionId: first.decisionId, discordGuildConfirmed: true } });
      let banned = older === "unban_member";
      const actions = new DiscordActions({ async messages() { return []; }, async member() { return { guildId: "10000000000000001", channelId: "10000000000000002", userId: "10000000000000003" }; } },
        { async assertPublicChannel() {} }, async (method) => {
          if (method === "PUT") { banned = true; return new Response(null, { status: 204 }); }
          if (method === "DELETE") { banned = false; return new Response(null, { status: 204 }); }
          return banned ? Response.json({ user: { id: "10000000000000003" } }) : Response.json({ code: 10026 }, { status: 404 });
        });
      const result = await actions.execute(claim!.decision);
      expect(result).toEqual({ state: "verified", code: "discord_enforcement_verified" });
      expect(banned).toBe(older === "ban_member");
      await outbox.complete(claim!, result.state, result.code);
      expect((await rows(first.decisionId)).filter(r => r.target !== "discord").every(r => r.result_code === "superseded_by_newer_decision" && r.superseded_by === second.decisionId)).toBe(true);
      expect((await rows(first.decisionId)).find(r => r.target === "discord")).toMatchObject({ state: "verified", superseded_by: null });
    } finally { await cleanup(first.decisionId, second.decisionId); }
  });

  test(`Guild ${newer} supersedes queued community ${older} and earlier Guild intent`, async () => {
    const accept = await subject(), first = await accept(older, true), middle = await accept(older, false), last = await accept(newer, true);
    try {
      for (const id of [first.decisionId, middle.decisionId, last.decisionId]) await park(id);
      expect(await outbox.claim()).toBeUndefined();
      expect((await rows(first.decisionId)).find(r => r.target === "discord")).toMatchObject({ state: "failed", result_code: "superseded_by_newer_decision", superseded_by: last.decisionId });
      expect((await rows(middle.decisionId)).every(r => r.result_code === "superseded_by_newer_decision" && r.superseded_by === last.decisionId)).toBe(true);
      await expect(api.retry(first.decisionId, staff)).rejects.toMatchObject({ code: "member_decision_superseded" });
    } finally { await cleanup(first.decisionId, middle.decisionId, last.decisionId); }
  });
}

for (const older of ["ban_member", "unban_member"] as const) test(`Retry resumes only surviving Guild ${older} after opposite community intent`, async () => {
  const accept = await subject(), first = await accept(older, true), second = await accept(older === "ban_member" ? "unban_member" : "ban_member", false);
  try {
    await park(first.decisionId); await park(second.decisionId);
    await sql`UPDATE moderation.deliveries SET state = 'failed', attempts = 1, result_code = 'synthetic_delivery_failure' WHERE decision_id = ${first.decisionId}`;
    await expect(api.retry(first.decisionId, moderator)).rejects.toMatchObject({ code: "member_decision_superseded" });
    const status = await api.retry(first.decisionId, staff);
    expect(status.deliveries.filter(d => d.state === "pending").map(d => d.target)).toEqual(["discord"]);
    const claim = await outbox.claim();
    expect(claim).toMatchObject({ target: "discord", decision: { decisionId: first.decisionId } });
    await outbox.complete(claim!, "verified", "synthetic_delivery_verified");
    expect((await rows(first.decisionId)).filter(r => r.target !== "discord").every(r => r.state === "failed")).toBe(true);
  } finally { await cleanup(first.decisionId, second.decisionId); }
});

test("a pruned newer Guild decision still fences older Guild delivery and Retry after community intent", async () => {
  const accept = await subject(), first = await accept("ban_member", true), second = await accept("unban_member", true), third = await accept("ban_member", false);
  try {
    await park(first.decisionId); await park(third.decisionId);
    await cleanup(second.decisionId);
    expect(await outbox.claim()).toBeUndefined();
    expect((await rows(first.decisionId)).find(r => r.target === "discord")).toMatchObject({ state: "failed", result_code: "superseded_by_newer_decision" });
    await expect(api.retry(first.decisionId, staff)).rejects.toMatchObject({ code: "member_decision_superseded" });
  } finally { await cleanup(first.decisionId, third.decisionId); }
});

test("a pruned community-only successor does not cancel retained Guild intent", async () => {
  const accept = await subject(), first = await accept("ban_member", true), second = await accept("unban_member", false);
  try {
    await park(first.decisionId); await cleanup(second.decisionId); await readyDiscord(first.decisionId);
    const claim = await outbox.claim();
    expect(claim).toMatchObject({ target: "discord", decision: { decisionId: first.decisionId } });
    await outbox.complete(claim!, "verified", "synthetic_delivery_verified");
    expect((await rows(first.decisionId)).filter(r => r.target !== "discord").every(r => r.result_code === "superseded_by_newer_decision")).toBe(true);
  } finally { await cleanup(first.decisionId); }
});

test("a community-only Discord no-op in flight does not delay later Guild intent", async () => {
  const accept = await subject(), first = await accept("unban_member", false);
  await park(first.decisionId); await readyDiscord(first.decisionId);
  const noop = await outbox.claim();
  expect(noop).toMatchObject({ target: "discord", decision: { decisionId: first.decisionId } });
  const second = await accept("ban_member", true);
  try {
    await park(second.decisionId); await readyDiscord(second.decisionId);
    const claim = await outbox.claim();
    expect(claim).toMatchObject({ target: "discord", decision: { decisionId: second.decisionId } });
    await outbox.complete(claim!, "verified", "synthetic_delivery_verified");
    await outbox.complete(noop!, "not_applicable", "guild_scope_not_requested");
  } finally { await cleanup(first.decisionId, second.decisionId); }
});

for (const older of ["ban_member", "unban_member"] as const) test(`an in-flight Guild ${older} settles before opposite Guild intent`, async () => {
  const accept = await subject(), first = await accept(older, true);
  await park(first.decisionId); await readyDiscord(first.decisionId);
  const sending = await outbox.claim();
  expect(sending).toMatchObject({ target: "discord", decision: { decisionId: first.decisionId } });
  const second = await accept(older === "ban_member" ? "unban_member" : "ban_member", true);
  try {
    await park(second.decisionId); await readyDiscord(second.decisionId);
    expect(await outbox.claim()).toBeUndefined();
    expect((await rows(first.decisionId)).find(r => r.target === "discord")).toMatchObject({ state: "pending", result_code: null });
    await outbox.complete(sending!, "verified", "synthetic_delivery_verified");
    const successor = await outbox.claim();
    expect(successor).toMatchObject({ target: "discord", decision: { decisionId: second.decisionId } });
    await outbox.complete(successor!, "verified", "synthetic_delivery_verified");
  } finally { await cleanup(first.decisionId, second.decisionId); }
});

test("repeated bootstrap preserves Guild fences and runtime roles cannot reset them", async () => {
  const accept = await subject(), first = await accept("ban_member", true), second = await accept("unban_member", false);
  try {
    await park(first.decisionId); await park(second.decisionId);
    await migrateModeration(sql);
    const [head] = await sql`SELECT latest_revision::text AS revision, latest_guild_revision::text AS guild_revision, guild_scope_known_after::text AS boundary
      FROM moderation.member_order_heads WHERE org_id = ${org} AND latest_execution_id = ${second.executionId}`;
    expect(head).toEqual({ revision: "2", guild_revision: "1", boundary: "0" });
    await expect(apiSql`UPDATE moderation.member_order_heads SET guild_scope_known_after = 1 WHERE org_id = ${org}`.execute()).rejects.toThrow(/permission denied/);
    await expect(apiSql`UPDATE moderation.member_order_heads SET latest_revision = 3, latest_guild_revision = NULL WHERE org_id = ${org} AND latest_execution_id = ${second.executionId}`.execute()).rejects.toThrow(/without losing Guild scope/);
    const operator = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
    try { await expect(operator`UPDATE moderation.member_order_heads SET latest_guild_revision = NULL WHERE org_id = ${org}`.execute()).rejects.toThrow(/permission denied/); }
    finally { await operator.end(); }
    await readyDiscord(first.decisionId);
    const claim = await outbox.claim();
    expect(claim?.decision.decisionId).toBe(first.decisionId);
    await outbox.complete(claim!, "verified", "synthetic_delivery_verified");
  } finally { await cleanup(first.decisionId, second.decisionId); }
});

test("populated upgrade fences unknown historical scope and refuses old Guild writers", async () => {
  const dbName = "guild_scope_upgrade_" + crypto.randomUUID().replaceAll("-", "");
  await sql.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/" + dbName;
  const upgrade = postgres(url.toString(), { onnotice() {} });
  const restricted = postgres(url.toString(), { connection: { options: "-c role=moderation_api" }, onnotice() {} });
  const historical = new Decisions(upgrade, cipher, new Map([[community, org]]), { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
  const fixture = async (seed: string, revision: number, guild: boolean, head = false) => {
    const id = crypto.randomUUID(), execution = crypto.randomUUID(), author = seed.repeat(64);
    if (head) await upgrade`INSERT INTO moderation.member_order_heads (org_id, community_id, author, latest_revision, latest_execution_id) VALUES (${org}, ${community}, ${author}, ${revision}, ${execution})`;
    await upgrade`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at, source_order_version, source_revision)
      VALUES (${id}, ${org}, ${execution}, ${"f".repeat(64)}, 2, ${crypto.randomUUID()}, ${community}, ${"7".repeat(64)}, ${"8".repeat(64)}, ${author}, 'ban_member', ${guild}, clock_timestamp() + interval '1 hour', 1, ${revision})`;
    await upgrade`INSERT INTO moderation.deliveries (decision_id, target) VALUES (${id}, 'discord')`;
    return id;
  };
  try {
    const directory = new URL("../db/migrations/", import.meta.url);
    const prior = (await readdir(directory)).filter(n => /^\d{3}_.*\.sql$/.test(n) && n < "016_").sort();
    for (const name of prior) await upgrade.unsafe(await readFile(new URL(name, directory), "utf8"));
    // Revision 2 is absent: its scope cannot be reconstructed from revision 3.
    const unknown = await fixture("a", 1, true), communityHead = await fixture("a", 3, false, true);
    const known = await fixture("b", 1, true), guildHead = await fixture("b", 3, true, true);
    const legacy = crypto.randomUUID();
    await upgrade`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at)
      VALUES (${legacy}, ${org}, ${crypto.randomUUID()}, ${"d".repeat(64)}, 1, ${crypto.randomUUID()}, ${community}, ${"7".repeat(64)}, ${"8".repeat(64)}, ${"c".repeat(64)}, 'ban_member', true, clock_timestamp() + interval '1 hour')`;
    await upgrade`INSERT INTO moderation.deliveries (decision_id, target) VALUES (${legacy}, 'discord')`;
    await migrateModeration(upgrade);
    await migrateModeration(upgrade);
    const heads = await upgrade`SELECT author, latest_guild_revision::text AS guild_revision, guild_scope_known_after::text AS boundary FROM moderation.member_order_heads ORDER BY author`;
    expect(heads.map(h => [h.guild_revision, h.boundary])).toEqual([["1", "3"], ["3", "3"]]);
    await upgrade`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${communityHead}`;
    const claim = await historical.claim();
    expect(claim?.decision.decisionId).toBe(guildHead);
    await historical.complete(claim!, "verified", "synthetic_delivery_verified");
    const unknownRow = (await upgrade`SELECT state, result_code, superseded_by FROM moderation.deliveries WHERE decision_id = ${unknown}`)[0];
    expect(unknownRow).toEqual({ state: "failed", result_code: "guild_scope_order_requires_operator", superseded_by: null });
    expect((await upgrade`SELECT result_code FROM moderation.deliveries WHERE decision_id = ${known}`)[0].result_code).toBe("superseded_by_newer_decision");
    await expect(historical.retry(unknown, staff)).rejects.toMatchObject({ code: "guild_scope_order_requires_operator" });
    expect((await upgrade`SELECT state, result_code FROM moderation.deliveries WHERE decision_id = ${legacy}`)[0]).toEqual({ state: "failed", result_code: "guild_scope_order_requires_operator" });
    await expect(historical.retry(legacy, staff)).rejects.toMatchObject({ code: "guild_scope_order_requires_operator" });
    // Old source-order-aware code advances only the global head. Its Guild
    // INSERT must fail without a matching durable Guild fence, atomically.
    await expect(restricted.begin(async tx => {
      const execution = crypto.randomUUID();
      await tx`UPDATE moderation.member_order_heads SET latest_revision = 4, latest_execution_id = ${execution} WHERE org_id = ${org} AND author = ${"a".repeat(64)}`;
      await tx`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at, source_order_version, source_revision)
        VALUES (${crypto.randomUUID()}, ${org}, ${execution}, ${"e".repeat(64)}, 2, ${crypto.randomUUID()}, ${community}, ${"7".repeat(64)}, ${"8".repeat(64)}, ${"a".repeat(64)}, 'unban_member', true, clock_timestamp() + interval '1 hour', 1, 4)`;
    })).rejects.toThrow(/Guild membership source-order head required/);
    expect((await upgrade`SELECT latest_revision::text AS revision FROM moderation.member_order_heads WHERE author = ${"a".repeat(64)}`)[0].revision).toBe("3");
  } finally {
    await restricted.end(); await upgrade.end();
    await sql.unsafe(`DROP DATABASE ${dbName}`);
  }
});
