import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { observeDiscordRestriction, DiscordRestrictionObserver } from "./discordRestriction";
import { Decisions } from "./decisions";
import { Lifecycle } from "./lifecycle";
import { EvidenceCipher } from "./evidence";
const apiSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_api" }, onnotice() {} });
const operatorSql = postgres(process.env.DATABASE_URL!, { connection: { options: "-c role=moderation_operator" }, onnotice() {} });
const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} }), f = await moderationFixture();
const org = `synthetic-restriction-${crypto.randomUUID()}`, communities = new Map([[f.community.idHex, org]]), cipher = new EvidenceCipher(randomBytes(32), 3600, 100000);
const member = { guildId: "100000000000000001", channelId: "100000000000000002", userId: "100000000000000003" }, policy = { async assertPublicChannel() {} }, mappings = { async messages() { return []; }, async member() { return member; } };
const decision = { decisionId: crypto.randomUUID(), orgId: org, caseId: crypto.randomUUID(), target: { communityId: f.community.idHex, channelId: f.channelId, rumorId: f.allowedRumorId }, author: f.member.pk, action: "unban_member" as const, discordGuildConfirmed: false, expiresAt: new Date(Date.now() + 3600000) };
beforeAll(async () => { await migrateModeration(sql); await new PolicyStore(sql).install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0); });
afterAll(async () => { await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`DELETE FROM moderation.lifecycle_events WHERE org_id = ${org}`; await tx`DELETE FROM moderation.discord_member_bindings WHERE org_id = ${org}`; await tx`DELETE FROM moderation.decisions WHERE org_id = ${org}`; await tx`DELETE FROM moderation.member_order_heads WHERE org_id = ${org}`; await tx`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }); await apiSql.end(); await operatorSql.end(); await sql.end(); });
test("community unban observes surviving Guild restriction using GET only", async () => {
 const calls: string[] = [];
 expect(await observeDiscordRestriction(decision, mappings, policy, async method => { calls.push(method); return Response.json({ user: { id: member.userId } }); }, true)).toMatchObject({ state: "present" });
 expect(calls).toEqual(["GET"]);
 expect(await observeDiscordRestriction(decision, mappings, policy, async () => Response.json({ code: 10026 }, { status: 404 }), true)).toMatchObject({ state: "absent" });
});
test("unknown mapping or provider failure never claims absence; native-only is not applicable", async () => {
 const missing = { ...mappings, async member() { return undefined; } };
 expect(await observeDiscordRestriction(decision, missing, policy, async () => { throw Error("No guess"); }, false)).toMatchObject({ state: "not_applicable" });
 expect(await observeDiscordRestriction(decision, missing, policy, async () => { throw Error("No guess"); }, true)).toMatchObject({ state: "unknown" });
 for (const response of [Response.json({ user: { id: "100000000000000099" } }), new Response(null, { status: 403 }), Response.json({ retry_after: 3 }, { status: 429 }), new Response("malformed"), Response.json({ code: 10003 }, { status: 404 })]) expect(await observeDiscordRestriction(decision, mappings, policy, async () => response, true)).toMatchObject({ state: "unknown" });
 expect(await observeDiscordRestriction(decision, mappings, policy, async () => { throw Error("timeout"); }, true)).toMatchObject({ state: "unknown" });
});
async function stored(action: "ban_member" | "unban_member", revision: string, guild: boolean) {
 const id = crypto.randomUUID();
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, source_order_version, source_revision, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, audit, expires_at) VALUES (${id}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 2, 1, ${revision}, ${decision.caseId}, ${decision.target.communityId}, ${decision.target.channelId}, ${decision.target.rumorId}, ${decision.author}, ${action}, ${guild}, ${cipher.seal(`${org}:${id}`, { actorId: "synthetic-admin", reason: "synthetic action" })}, clock_timestamp() - interval '1 day')`; });
 for (const target of ["concord", "divine_relay", "discord"]) await sql`INSERT INTO moderation.deliveries (decision_id, target, state) VALUES (${id}, ${target}, 'verified')`;
 return id;
}
test("fresh absent observation permits settled ban audit closure; source changes invalidate proof", async () => {
 const ban = await stored("ban_member", "1", true), unban = await stored("unban_member", "2", false);
 const [accepted] = await sql`SELECT execution_id FROM moderation.decisions WHERE decision_id = ${unban}`;
 await sql`INSERT INTO moderation.member_order_heads (org_id, community_id, author, latest_revision, latest_execution_id, latest_guild_revision) VALUES (${org}, ${decision.target.communityId}, ${decision.author}, 2, ${accepted.execution_id}, 1)`;
 await sql`UPDATE moderation.member_bans SET blocked = false WHERE community_id = ${decision.target.communityId} AND author = ${decision.author}`;
 const observer = new DiscordRestrictionObserver(operatorSql, mappings, policy, async () => Response.json({ user: { id: member.userId } }), communities);
 const staff = { orgId: org, actorId: "synthetic-admin", permissions: ["view", "manage_moderation_records"] }, lifecycle = new Lifecycle(apiSql, cipher, communities, { auditRetentionSeconds: 60, holdMaxSeconds: 3600 });
 await observer.refresh(ban);
 expect((await new Decisions(sql, cipher, communities).get(ban, staff)).discordRestriction?.state).toBe("present");
 await expect(lifecycle.closeLifecycle({ decisionId: ban, reason: "still banned on Discord" }, staff)).rejects.toThrow();
 const absent = new DiscordRestrictionObserver(operatorSql, mappings, policy, async () => Response.json({ code: 10026 }, { status: 404 }), communities);
 await absent.refresh(ban);
 expect((await lifecycle.closeLifecycle({ decisionId: ban, reason: "settled independent sanction" }, staff)).closedAt).toBeString();
 const next = await stored("unban_member", "3", false), [nextRow] = await sql`SELECT execution_id FROM moderation.decisions WHERE decision_id = ${next}`;
 await sql`UPDATE moderation.member_order_heads SET latest_revision = 3, latest_execution_id = ${nextRow.execution_id} WHERE org_id = ${org}`;
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${ban}`; await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE decision_id = ${ban}`; });
 await expect(Promise.resolve(apiSql`UPDATE moderation.decisions SET audit = NULL WHERE decision_id = ${ban}`)).rejects.toThrow(/audit/i);
 const cleanup = new Lifecycle(operatorSql, undefined, communities, {}); await cleanup.expireAudit();
 expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${ban}`)[0].audit).not.toBeNull();
 await lifecycle.setAppeal({ decisionId: ban, state: "open", reason: "reopen" }, staff); await lifecycle.setAppeal({ decisionId: ban, state: "closed", reason: "resolve" }, staff);
 await expect(lifecycle.closeLifecycle({ decisionId: ban, reason: "stale source" }, staff)).rejects.toThrow();
 await absent.refresh(ban); await lifecycle.closeLifecycle({ decisionId: ban, reason: "fresh source proof" }, staff);
 await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET lifecycle_closed_at = clock_timestamp() - interval '2 minutes', audit_delete_after = clock_timestamp() - interval '1 minute' WHERE decision_id = ${ban}`; await tx`UPDATE moderation.lifecycle_events SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE decision_id = ${ban}`; });
 await cleanup.expireAudit(); expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id = ${ban}`)[0].audit).toBeNull();
});

test("a concurrent source change discards observation; unchanged policy polling preserves its identity", async () => {
 const [row] = await sql`SELECT decision_id FROM moderation.decisions WHERE org_id = ${org} ORDER BY decision_id LIMIT 1`;
 const before = (await sql`SELECT discord_restriction_state, discord_restriction_proof_key, discord_restriction_checked_at FROM moderation.deliveries WHERE decision_id = ${row.decision_id} AND target = 'discord'`)[0];
 const concurrent = new DiscordRestrictionObserver(operatorSql, mappings, policy, async () => {
   await sql`UPDATE moderation.member_order_heads SET latest_revision = latest_revision + 1, latest_execution_id = ${crypto.randomUUID()} WHERE org_id = ${org}`;
   return Response.json({ code: 10026 }, { status: 404 });
 }, communities);
 expect(await concurrent.refresh(row.decision_id)).toBe(false);
 expect((await sql`SELECT discord_restriction_state, discord_restriction_proof_key, discord_restriction_checked_at FROM moderation.deliveries WHERE decision_id = ${row.decision_id} AND target = 'discord'`)[0]).toEqual(before);
 const polling = new DiscordRestrictionObserver(operatorSql, mappings, policy, async () => {
   const store = new PolicyStore(sql), current = (await store.getPolicy(f.community.idHex))!;
   await store.install({ ...current, revision: current.revision + 1, validUntil: Date.now() + 30000 }, [f.chatStream, f.controlStream, f.guestbookStream], current.revision);
   return Response.json({ code: 10026 }, { status: 404 });
 }, communities);
 expect(await polling.refresh(row.decision_id)).toBe(true);
});

import { BridgeMappingResolver } from "./discordActions";
import { derivePuppet } from "../../bridge/src/puppets";
import { migrate } from "../../bridge/src/db/migrate";
test("verified binding survives original mapping deletion and refuses a changed puppet identity", async () => {
 await migrate(process.env.DATABASE_URL!);
 const key = randomBytes(32).toString("hex"), author = derivePuppet(key, member.userId).pk, id = crypto.randomUUID(), tenant = crypto.randomUUID();
 await sql`INSERT INTO moderation.decisions (decision_id, org_id, execution_id, fingerprint, fingerprint_version, case_id, community_id, channel_id, rumor_id, author, action, discord_guild_confirmed, expires_at) VALUES (${id}, ${org}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 1, ${crypto.randomUUID()}, ${decision.target.communityId}, ${decision.target.channelId}, ${decision.target.rumorId}, ${author}, 'ban_member', false, clock_timestamp() - interval '1 day')`;
 const source = { ...decision, decisionId: id, author };
 await sql`INSERT INTO messages (tenant_id, discord_message_id, discord_channel_id, concord_rumor_id, concord_channel_id, community_id, origin, author_ref) VALUES (${tenant}, ${"100000000000000005"}, ${member.channelId}, ${source.target.rumorId}, ${source.target.channelId}, ${source.target.communityId}, 'discord', ${member.userId})`;
 const resolver = new BridgeMappingResolver(sql, tenant, member.guildId, key);
 expect(await resolver.member(source)).toEqual(member);
 await sql`DELETE FROM messages WHERE tenant_id = ${tenant}`;
 expect(await resolver.member(source)).toEqual(member);
 expect(await new BridgeMappingResolver(sql, tenant, member.guildId, randomBytes(32).toString("hex")).member(source)).toBeUndefined();
});

test("native settled reversal closes after evidence deletion using the production resolver and scheduled worker observation", async () => {
 await migrate(process.env.DATABASE_URL!);
 const g = await moderationFixture();
 await new PolicyStore(sql).install(g.policy,[g.chatStream,g.controlStream,g.guestbookStream],0);
 const nativeOrg = `synthetic-native-${crypto.randomUUID()}`, scope = new Map([[g.community.idHex, nativeOrg]]), ban = crypto.randomUUID(), unban = crypto.randomUUID(), caseId = crypto.randomUUID(), executionId = crypto.randomUUID();
 try {
   await sql.begin(async tx => {
     await tx`SET LOCAL session_replication_role = replica`;
     for (const [id, action, revision, execution] of [[ban, "ban_member", 1, crypto.randomUUID()], [unban, "unban_member", 2, executionId]] as const) {
       await tx`INSERT INTO moderation.decisions(decision_id,org_id,case_id,execution_id,fingerprint,fingerprint_version,source_order_version,source_revision,community_id,channel_id,rumor_id,author,action,discord_guild_confirmed,audit,expires_at) VALUES(${id},${nativeOrg},${caseId},${execution},${crypto.randomUUID()},2,1,${revision},${g.community.idHex},${g.channelId},${g.allowedRumorId},${g.member.pk},${action},false,${cipher.seal(`${nativeOrg}:${id}`, {actorId:"synthetic-admin",reason:"synthetic native action"})},clock_timestamp()-interval '1 second')`;
       for (const target of ["concord","divine_relay","discord"]) await tx`INSERT INTO moderation.deliveries(decision_id,target,state,available_at) VALUES(${id},${target},${target === "discord" ? "not_applicable" : "verified"},clock_timestamp())`;
     }
     await tx`INSERT INTO moderation.member_order_heads(org_id,community_id,author,latest_revision,latest_execution_id) VALUES(${nativeOrg},${g.community.idHex},${g.member.pk},2,${executionId})`;
   });
   const actor = { orgId:nativeOrg,actorId:"synthetic-admin",permissions:["view","manage_moderation_records"] };
   const observer = new DiscordRestrictionObserver(operatorSql,new BridgeMappingResolver(sql,"default",member.guildId,randomBytes(32).toString("hex")),policy,async()=>{throw Error("Native observation must not contact Discord");},scope);
   await new Decisions(apiSql,cipher,scope).refreshDiscordRestriction(ban,actor);
   await observer.tick(); await observer.tick();
   expect((await new Decisions(apiSql,cipher,scope).get(ban,actor)).discordRestriction).toMatchObject({state:"not_applicable"});
   const lifecycle = new Lifecycle(apiSql,cipher,scope,{auditRetentionSeconds:60,holdMaxSeconds:3600});
   expect((await sql`SELECT publication_attempted FROM moderation.deliveries WHERE decision_id=${ban} AND target='discord'`)[0].publication_attempted).toBe(true);
   await sql`UPDATE moderation.deliveries SET state='not_applicable', result_code='operator_unknown' WHERE decision_id=${ban} AND target='concord'`;
   await expect(lifecycle.closeLifecycle({decisionId:ban,reason:"Unknown Concord publication must remain open"},actor)).rejects.toThrow();
   await sql`UPDATE moderation.deliveries SET state='verified', result_code='concord_enforcement_verified' WHERE decision_id=${ban} AND target='concord'`;
   expect((await lifecycle.closeLifecycle({decisionId:ban,reason:"Settled native reversal"},actor)).closedAt).toBeString();
   const cleanup = new Lifecycle(operatorSql,undefined,scope,{}); await cleanup.expireAudit();
   expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id=${ban}`)[0].audit).not.toBeNull();
   await sql.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx`UPDATE moderation.decisions SET lifecycle_closed_at=clock_timestamp()-interval '2 minutes', audit_delete_after=clock_timestamp()-interval '1 minute' WHERE decision_id=${ban}`;await tx`UPDATE moderation.lifecycle_events SET recorded_at=clock_timestamp()-interval '2 minutes' WHERE decision_id=${ban}`;});
   await sql`UPDATE moderation.deliveries SET state='not_applicable',result_code='operator_unknown' WHERE decision_id=${ban} AND target='concord'`;
   await expect(Promise.resolve(apiSql`UPDATE moderation.decisions SET audit=NULL WHERE decision_id=${ban}`)).rejects.toThrow(/audit/i);
   await cleanup.expireAudit(); expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id=${ban}`)[0].audit).not.toBeNull();
   await sql`UPDATE moderation.deliveries SET state='verified',result_code='concord_enforcement_verified' WHERE decision_id=${ban} AND target='concord'`;
   await cleanup.expireAudit(); expect((await sql`SELECT audit FROM moderation.decisions WHERE decision_id=${ban}`)[0].audit).toBeNull();
 } finally { await sql.begin(async tx=>{await tx`SET LOCAL session_replication_role = replica`;await tx`DELETE FROM moderation.lifecycle_events WHERE org_id=${nativeOrg}`;await tx`DELETE FROM moderation.decisions WHERE org_id=${nativeOrg}`;await tx`DELETE FROM moderation.member_order_heads WHERE org_id=${nativeOrg}`;await tx`DELETE FROM moderation.community_policy WHERE community_id=${g.community.idHex}`;}); }
});
