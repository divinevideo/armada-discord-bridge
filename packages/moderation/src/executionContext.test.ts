import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
import { migrateModeration, PolicyStore } from "./policyStore";
import { createExecutionContext } from "./executionContext";
import { ConcordActions } from "./concordActions";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { randomBytes } from "node:crypto";
import { buildBanlistEdition, currentControlWriteGroup, openWrap, parseEdition, sealEdition } from "@armada-bridge/concord-core";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
afterAll(() => sql.end());
test("relay bans commit before draining writers and unban waits for verified Concord delivery", async () => {
  await migrateModeration(sql);
  const f = await moderationFixture(), store = new PolicyStore(sql);
  try {
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    let barriers = 0;
    const context = createExecutionContext({ sql, store, actions: new ConcordActions(f.community, f.moderator, async () => (await store.getPolicy(f.community.idHex))!), claim: { decision: { ...f.decision, action: "ban_member" }, target: "divine_relay", attempts: 1, token: crypto.randomUUID(), signedEvents: null }, assertCurrent: async () => {}, decisions: {} as any, relay: {} as any, discord: {} as any, purger: {} as any, driver: { barrier: async <T>(work: () => Promise<T>) => { barriers++; expect((await store.admit(f.allowed)).action).toBe("reject"); return work(); } } });
    expect(await context.setRelayBan({ ...f.decision, action: "ban_member" })).toBe(true);
    expect(barriers).toBe(1);
    expect(await context.setRelayBan({ ...f.decision, action: "unban_member" })).toBe(false);
    expect((await store.admit(f.allowed)).action).toBe("reject");
  } finally { await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`; }
});

test("an unban extended by an owner edition verifies the durable outbox and lifts relay admission", async () => {
  await migrateModeration(sql);
  const f = await moderationFixture(), store = new PolicyStore(sql), orgId = crypto.randomUUID(), caseId = crypto.randomUUID();
  const actor = { orgId, actorId: "synthetic-reviewer", permissions: ["unban_member", "view"] };
  const decisions = new Decisions(sql, new EvidenceCipher(randomBytes(32), 3600, 100_000), new Map([[f.community.idHex, orgId]]));
  try {
    const original = parseEdition(openWrap(f.policy.controlEvents.at(-1)!, f.controlStream.key));
    f.policy.controlEvents.push(await sealEdition(buildBanlistEdition(f.community.id, [f.member.pk, f.bannedMember.pk], { actorPubkey: f.owner.pk, version: original.version + 1n, prevHash: original.selfHash }), currentControlWriteGroup(f.community), f.owner.signer));
    await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
    await store.setBan(f.community.idHex, f.member.pk, true);
    await sql`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
      VALUES (${caseId}, ${orgId}, ${f.community.idHex}, ${f.channelId}, ${f.allowedRumorId}, ${f.member.pk}, ${crypto.randomUUID()}, ${Buffer.from("synthetic")}, clock_timestamp() + interval '1 hour')`;
    const accepted = await decisions.acceptDecision({ caseId, executionId: crypto.randomUUID(), sourceOrder: { version: 1, revision: "1" }, action: "unban_member", reason: "Synthetic unban", scope: "community", discordGuildConfirmed: false }, actor);
    await sql`UPDATE moderation.deliveries SET available_at = clock_timestamp() + interval '1 hour' WHERE decision_id = ${accepted.decisionId} AND target <> 'concord'`;
    const claim = (await decisions.claim())!;
    expect(claim.target).toBe("concord");
    const actions = new ConcordActions(f.community, f.moderator, async () => (await store.getPolicy(f.community.idHex))!);
    const context = createExecutionContext({ sql, store, actions, claim, assertCurrent: async () => {}, decisions,
      relay: {
        publish: async (event) => {
          const edition = parseEdition(openWrap(event, f.controlStream.key));
          const successor = await sealEdition(buildBanlistEdition(f.community.id, [f.bannedMember.pk, "ef".repeat(32)], { actorPubkey: f.owner.pk, version: edition.version + 1n, prevHash: edition.selfHash }), currentControlWriteGroup(f.community), f.owner.signer);
          const policy = (await store.getPolicy(f.community.idHex))!;
          await store.install({ ...policy, revision: policy.revision + 1, controlEvents: [...policy.controlEvents, event, successor] }, [f.chatStream, f.controlStream, f.guestbookStream], policy.revision);
        }, queryStrict: async () => claim.signedEvents as any[],
      }, discord: {} as any, purger: {} as any, driver: { barrier: (work) => work() },
    });
    expect((await store.admit(f.allowed)).action).toBe("reject");
    expect(await context.setRelayBan(claim.decision)).toBe(false);
    const result = await context.executeConcord(claim.decision);
    expect(result).toEqual({ state: "verified", code: "concord_enforcement_verified" });
    await decisions.complete(claim, result.state, result.code);
    expect(await context.setRelayBan(claim.decision)).toBe(true);
    expect((await store.admit(f.allowed)).action).toBe("accept");
    expect((await decisions.get(accepted.decisionId, actor)).deliveries.find((delivery) => delivery.target === "concord")?.state).toBe("verified");
  } finally {
    await sql`DELETE FROM moderation.decisions WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.cases WHERE org_id = ${orgId}`;
    await sql`DELETE FROM moderation.community_policy WHERE community_id = ${f.community.idHex}`;
  }
});
