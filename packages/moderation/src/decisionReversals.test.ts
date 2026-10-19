import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { migrateModeration } from "./policyStore";
import { createModerationApi, signCoopRequest } from "./api";
const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
const org = `synthetic-reversal-${crypto.randomUUID()}`, community = "7".repeat(64), cipher = new EvidenceCipher(randomBytes(32), 3600, 100000);
const actor = { orgId: org, actorId: "synthetic-admin", permissions: ["view", "unban_member", "retry", "discord_guild_ban"] }, communities = new Map([[community, org]]);
const decisions = new Decisions(apiSql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 }), secret = randomBytes(32);
const api = createModerationApi({ publicOrigin: "https://rooms.example", coopSecret: secret, orgs: new Set([org]), reports: { async submitReport() { throw Error("unused"); } }, decisions });
beforeAll(() => migrateModeration(sql));
afterAll(async () => { await sql`DELETE FROM moderation.decisions WHERE org_id = ${org} AND reverses_decision_id IS NOT NULL`; await sql`DELETE FROM moderation.decisions WHERE org_id = ${org}`; await sql`DELETE FROM moderation.cases WHERE org_id = ${org}`; await apiSql.end(); await sql.end(); });
async function prior(guild = false) {
 const id = crypto.randomUUID(), caseId = crypto.randomUUID(), author = randomBytes(32).toString("hex");
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at) VALUES (${id}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 1, ${caseId}, ${community}, ${"8".repeat(64)}, ${"9".repeat(64)}, ${author}, 'ban_member', ${guild}, clock_timestamp() - interval '1 day')`; });
 for (const target of ["concord", "divine_relay", "discord"]) await sql`INSERT INTO moderation.deliveries (decision_id, target, state) VALUES (${id}, ${target}, 'verified')`;
 return { id, caseId, author };
}
const request = (revision = "1") => ({ executionId: crypto.randomUUID(), action: "unban_member" as const, reason: "synthetic fresh reversal", scope: "community" as const, discordGuildConfirmed: false, sourceOrder: { version: 1 as const, revision } });
async function call(path: string, input?: unknown, staff = actor) { const body = input === undefined ? "" : JSON.stringify(input), method = input === undefined ? "GET" : "POST"; return api(new Request("https://rooms.example" + path, { method, ...(input === undefined ? {} : { body }), headers: signCoopRequest(secret, staff, method, path, body) })); }
test("expired_deleted_case_can_be_reversed with a fresh window and server-owned target", async () => {
 const old = await prior(), input = request();
 const context = await call(`/v1/decisions/${old.id}/reversal-context`); expect(context.status).toBe(200);
 expect(await context.json()).toEqual({ decisionId: old.id, caseId: old.caseId, communityId: community, channelId: "8".repeat(64), rumorId: "9".repeat(64), author: old.author, action: "ban_member", discordGuildConfirmed: false });
 const response = await call(`/v1/decisions/${old.id}/reversals`, input); expect(response.status).toBe(202);
 const status = await response.json() as { decisionId: string; target: unknown; sourceOrder: unknown };
 expect(status.target).toEqual({ communityId: community, channelId: "8".repeat(64), rumorId: "9".repeat(64) }); expect(status.sourceOrder).toEqual(input.sourceOrder);
 const [row] = await sql`SELECT * FROM moderation.decisions WHERE decision_id = ${status.decisionId}`;
 expect(row.reverses_decision_id).toBe(old.id); expect(row.fingerprint_version).toBe(3); expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(3500000);
 expect((await sql`SELECT case_id FROM moderation.cases WHERE case_id = ${old.caseId}`).length).toBe(0);
 await expect(decisions.retry(old.id, actor)).rejects.toThrow();
 expect((await call(`/v1/decisions/${old.id}/reversals`, { ...input, target: { author: "a".repeat(64) } })).status).toBe(400);
});
test("duplicate reversal preserves acceptance before policy/source lookup; changed prior conflicts", async () => {
 const old = await prior(), input = request(), first = await decisions.acceptReversal(old.id, input, actor);
 const missing = new Decisions(apiSql, cipher, communities);
 expect((await missing.acceptReversal(old.id, input, actor)).decisionId).toBe(first.decisionId);
 await expect(decisions.acceptReversal((await prior()).id, input, actor)).rejects.toThrow(/conflict/);
 await expect(decisions.acceptReversal(old.id, { ...input, reason: "changed" }, actor)).rejects.toThrow(/conflict/);
});
test("reversal authorization, definitive source refusal and source order remain fenced", async () => {
 const old = await prior(true);
 await expect(decisions.acceptReversal(old.id, request(), { ...actor, permissions: ["view"] })).rejects.toThrow();
 await expect(decisions.acceptReversal(old.id, { ...request(), discordGuildConfirmed: true }, { ...actor, permissions: ["unban_member"] })).rejects.toThrow();
 await expect(decisions.acceptReversal(old.id, request(), { ...actor, orgId: "other" })).rejects.toMatchObject({ code: "decision_source_unavailable" });
 const missing = request(); const refused = await call(`/v1/decisions/${crypto.randomUUID()}/reversals`, missing);
 expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: "decision_source_unavailable", executionId: missing.executionId });
 await sql`UPDATE moderation.deliveries SET state = 'failed' WHERE decision_id = ${old.id} AND target = 'concord'`;
 await expect(decisions.acceptReversal(old.id, request(), actor)).rejects.toMatchObject({ code: "decision_source_unavailable" });
 await sql`UPDATE moderation.deliveries SET state = 'verified' WHERE decision_id = ${old.id}`;
 const first = await decisions.acceptReversal(old.id, request("2"), actor);
 await expect(decisions.acceptReversal(old.id, request("1"), actor)).rejects.toMatchObject({ code: "member_intent_superseded" });
 expect(first.sourceOrder).toEqual({ version: 1, revision: "2" });
});

test("new revision supersedes an older unsent reversal without reviving the old ban", async () => {
 const old = await prior(), first = await decisions.acceptReversal(old.id, request("1"), actor), next = await decisions.acceptReversal(old.id, request("2"), actor);
 await decisions.claim();
 expect((await decisions.get(first.decisionId, actor)).deliveries.every(d => d.resultCode === "superseded_by_newer_decision")).toBe(true);
 expect((await decisions.get(first.decisionId, actor)).supersededBy).toBe(next.decisionId);
 expect((await decisions.get(old.id, actor)).deliveries.every(d => d.state === "verified")).toBe(true);
});
