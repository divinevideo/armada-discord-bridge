import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED } from "@armada-bridge/concord-core";
import { relayFixture } from "../../../scripts/fixtures/relay-events";
import { PolicyStore, migrateModeration } from "./policyStore";
import { CarrierIndex } from "./carrierIndex";
import { RelayPurger } from "./relayPurge";
import { RelayEvidenceResolver } from "./evidence";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const communities: string[] = [];
beforeAll(() => migrateModeration(sql));
afterAll(async () => { for (const id of communities) await sql`DELETE FROM moderation.community_policy WHERE community_id = ${id}`; await sql.end(); });
async function setup() {
  const f = await relayFixture(), store = new PolicyStore(sql);
  communities.push(f.policy.communityId);
  await store.install(f.policy, [f.chatStream, f.controlStream, f.guestbookStream], 0);
  expect((await store.admit(f.allowed)).action).toBe("accept");
  const target = { communityId: f.policy.communityId, channelId: f.channelId, rumorId: f.allowedRumorId };
  const related = async (kind: number, content: string, ms: number, id = target.rumorId) => {
    const seal = await sealRumor(buildRumor({ pubkey: f.member.pk, kind, content, tags: [...channelBindingTags(f.channelId, 0n), ["e", id]], ms }), KIND_SEAL_ENCRYPTED, f.chatKey, f.member.signer);
    return { seal, event: wrapSeal(seal, f.chatKey) };
  };
  return { f, store, target, related };
}
test("removal includes every edit/reaction wrapper and blocks new and alternate related carriers", async () => {
  const { f, store, target, related } = await setup();
  const edit = await related(3302, "Synthetic edited body", Date.now()), reaction = await related(7, "+", Date.now());
  const alternate = wrapSeal(edit.seal, f.chatKey);
  const stored = [f.allowed, edit.event, alternate, reaction.event];
  for (const event of stored.slice(1)) expect((await store.admit(event)).action).toBe("accept");
  const live = new Set(stored.map((event) => event.id));
  const result = await new RelayPurger(new CarrierIndex(sql), { barrier: (work) => work(), async delete(ids) { ids.forEach((id) => live.delete(id)); }, async remaining(ids) { return ids.filter((id) => live.has(id)); } }).removeFromRelay(target, crypto.randomUUID());
  expect(result.state).toBe("verified");
  expect(result.carrierIds.sort()).toEqual(stored.map((event) => event.id).sort());
  expect(live.size).toBe(0);
  for (const event of [edit.event, wrapSeal(edit.seal, f.chatKey), (await related(3302, "Synthetic later edit", Date.now() + 10)).event, reaction.event]) expect((await store.admit(event)).action).toBe("reject");
});
test("evidence resolves the latest verified author edit, independent of arrival order", async () => {
  const { f, store, target, related } = await setup();
  const older = await related(3302, "Synthetic older edit", Date.now()), latest = await related(3302, "Synthetic latest edit", Date.now() + 10);
  for (const event of [latest.event, older.event]) expect((await store.admit(event)).action).toBe("accept");
  const api = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { options: "-c role=moderation_api" } });
  try {
    const events = [older.event, f.allowed, latest.event];
    const resolver = new RelayEvidenceResolver(api, async (ids) => events.filter((event) => ids.includes(event.id)));
    expect(await resolver.resolve(target)).toMatchObject({ author: f.member.pk, content: "Synthetic latest edit", editCarrier: latest.event, carrier: f.allowed });
    events.pop();
    await expect(resolver.resolve(target)).rejects.toThrow(/edit unavailable/);
  } finally { await api.end(); }
});
test("legacy reference metadata fails closed until verified offline reindexing, including banned authors", async () => {
  const { f, store, target, related } = await setup();
  const edit = await related(3302, "Synthetic legacy edit", Date.now());
  expect((await store.admit(edit.event)).action).toBe("accept");
  await sql`UPDATE moderation.carriers SET targets_indexed = false, target_rumor_ids = '{}' WHERE event_id = ${edit.event.id}`;
  await migrateModeration(sql);
  await expect(new CarrierIndex(sql).ids(target)).rejects.toThrow(/reindexing/);
  await store.setBan(f.policy.communityId, f.member.pk, true);
  await store.remove(target);
  expect(await store.admitRestored(edit.event)).toBe(false);
  const [row] = await sql`SELECT targets_indexed, target_rumor_ids FROM moderation.carriers WHERE event_id = ${edit.event.id}`;
  expect(row.targets_indexed).toBe(true); expect(row.target_rumor_ids).toEqual([target.rumorId]);
  expect(await new CarrierIndex(sql).ids(target)).toContain(edit.event.id);
});
