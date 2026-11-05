import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, channelsView, controlGroups, grantLocator, bytesToHex, hex32, openChatBatch, openControlWraps, foldControlState } from '@armada-bridge/concord-core';
import { generateSecretKey } from 'nostr-tools/pure';
import fixture from '../../../../test-fixtures/concord/community-interop.json';
import { moderationFixture } from '../../../../scripts/fixtures/moderation-events';
import { bootstrapFixture } from '../../../../scripts/fixtures/community-bootstrap';
import { ConcordClient } from '../concord/client';
import { localIdentity } from '../concord/signer';
import { PuppetCache } from '../puppets';
import { BridgeRouter, MAX_PENDING_DELETES_PER_ACTOR, MAX_PENDING_DELETES_PER_LINK } from '../router';
import type { ChannelLink, PendingConcordDelete } from '../router';
import { PostgresMappingStore } from './store';
import { migrate } from './migrate';

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { max: 4, onnotice: () => {} });
const tenant = `pending-delete-${crypto.randomUUID()}`;
const link: ChannelLink = { communityId: fixture.expected.communityId, concordChannelIdHex: fixture.expected.message.channelId, discordChannelId: 'synthetic-channel', discordGuildId: 'synthetic-guild', enabled: true };
const pending = (id: string, author = 'actor'): PendingConcordDelete => ({ deleteRumorId: id, targetRumorId: id, author, createdAtMs: Date.now(), actionClass: 'actionable' });
beforeAll(() => migrate(url));
afterAll(async () => {
  await sql`DELETE FROM pending_concord_deletes WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM channel_delivery_checkpoints WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM retired_concord_reactions WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM reaction_mappings WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM messages WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM cursors WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql.end();
});

describe('durable pending Concord deletions', () => {
  it('replays a held signed citation after restart even when its relay cursor has advanced', async () => {
    const { community, folded } = bootstrapFixture(fixture);
    const channel = channelsView(community, folded)[0];
    const client = new ConcordClient(community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
    const grant = bytesToHex(grantLocator(community.id, hex32(fixture.expected.moderator)));
    client.folded = foldControlState(openControlWraps(fixture.controlEvents, controlGroups(community)).filter(edition => bytesToHex(edition.entityId) !== grant), community.id, community.owner);
    let connection = postgres(url, { max: 1 });
    let store = new PostgresMappingStore(connection, tenant);
    const deleted: string[] = [];
    const create = () => new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
      send: async () => 'synthetic-message', delete: async (_link,id,check) => { check?.(); deleted.push(id); },
      edit: async () => {}, react: async () => {}, unreact: async () => {}, sendTyping: async () => {},
    }, { resolve: async name => ({ name }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
    await store.insert({ discordMessageId: 'synthetic-message', discordChannelId: link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: channel.idHex, communityId: community.idHex, origin: 'concord', authorRef: fixture.expected.member, partIndex: 0 });
    const deletion = (await openChatBatch([fixture.moderatorDeleteEvent], channel))[0];
    await create().onConcordChat(deletion, link);
    expect(deleted).toEqual([]);
    expect(await store.pendingDeletes(link)).toHaveLength(1);
    await store.cursorSet(community.idHex, channel.current.group.pk, deletion.createdAt + 600);
    await connection.end();
    connection = postgres(url, { max: 1 });
    store = new PostgresMappingStore(connection, tenant);
    client.folded = folded;
    await create().retryPendingDeletes(link,true);
    expect(deleted).toEqual(['synthetic-message']);
    expect(await store.pendingDeletes(link)).toEqual([]);
    await connection.end();
  });

  it('retains retired reaction evidence across crash, later signed deletes and reaction re-add', async () => {
    const f = await moderationFixture();
    const client = new ConcordClient(f.community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
    client.folded = foldControlState(openControlWraps(f.policy.controlEvents, controlGroups(f.community)), f.community.id, f.owner.pk);
    const channel = channelsView(f.community, client.folded)[0];
    const scope = { ...link, communityId: f.community.idHex, concordChannelIdHex: channel.idHex };
    const testTenant = tenant + '-reaction';
    let connection = postgres(url, { max: 1 });
    let store = new PostgresMappingStore(connection, testTenant);
    let reacted = 0, unreacted = 0, sequence = 0;
    const event = async (kind: number, target: string) => {
      const rumor = buildRumor({ pubkey: f.member.pk, kind, content: kind === 7 ? '👍' : '', tags: [...channelBindingTags(channel.idHex, 0n), ['e', target]], ms: Date.now() + sequence++ });
      return (await openChatBatch([wrapSeal(await sealRumor(rumor, 20013, channel.current.group, f.member.signer), channel.current.group)], channel))[0];
    };
    const create = () => new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
      send: async () => 'reaction-parent', delete: async () => {}, edit: async () => {}, react: async () => { reacted++; },
      unreact: async (_link, _id, _emoji, authorize) => { authorize?.(); unreacted++; }, sendTyping: async () => {},
    }, { resolve: async name => ({ name }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
    await store.insert({ discordMessageId: 'reaction-parent', discordChannelId: scope.discordChannelId, concordRumorId: f.allowedRumorId, concordChannelId: channel.idHex, communityId: f.community.idHex, origin: 'concord', authorRef: f.member.pk, partIndex: 0 });
    let router = create();
    const reaction = await event(7, f.allowedRumorId);
    await router.onConcordChat(reaction, scope);
    const deletion = await event(5, reaction.rumorId);
    // Crash boundary: retirement committed, pending-action cleanup did not.
    store.completeDelete = async () => { throw new Error('crash before completion'); };
    await router.onConcordChat(deletion, scope);
    expect(unreacted).toBe(1);
    expect(await store.reactionByRumorId(reaction.rumorId)).toBeUndefined();
    expect(await store.pendingDeletes(scope)).toHaveLength(1);
    expect(await store.retiredReaction(scope, reaction.rumorId)).toMatchObject({ authorRef: f.member.pk });
    expect(await store.retiredReaction({ ...scope, discordChannelId: 'another-channel' }, reaction.rumorId)).toBeUndefined();
    expect(await store.retiredReaction({ ...scope, discordGuildId: 'another-guild' }, reaction.rumorId)).toBeUndefined();
    await connection.end();
    connection = postgres(url, { max: 1 }); store = new PostgresMappingStore(connection, testTenant); router = create();
    await router.retryPendingDeletes(scope,true);
    expect(await store.pendingDeletes(scope)).toEqual([]);
    const readded = await event(7, f.allowedRumorId);
    await router.onConcordChat(readded, scope);
    await router.onConcordChat(await event(5, reaction.rumorId), scope);
    await router.retryPendingDeletes(scope,true);
    expect(await store.pendingDeletes(scope)).toEqual([]);
    expect(unreacted).toBe(1); // Old-target duplicate must not remove the new reaction.
    expect(reacted).toBe(2);
    expect(await store.reactionByRumorId(readded.rumorId)).toBeDefined();
    expect(await store.reactionByDiscord('reaction-parent', f.member.pk, '👍')).toMatchObject({ rumorId: readded.rumorId });
    await router.onConcordChat(reaction, scope); // retired rumor replay cannot resurrect it
    expect(reacted).toBe(2);
    await connection.end();
  });

  it('persists full-link replay floors across restart and rekey without inheriting another link progress', async () => {
    const testTenant = tenant + '-checkpoint';
    const legacyFloor = fixture.moderatorDeleteEvent.created_at - 60;
    let connection = postgres(url, { max: 1 });
    let store = new PostgresMappingStore(connection, testTenant);
    await store.cursorSet(link.communityId, 'legacy-old', legacyFloor);
    await store.cursorSet(link.communityId, 'legacy-new', legacyFloor + 120);
    // Inherit the low watermark, never the fastest legacy stream.
    expect(await store.channelCursorStart(link, ['legacy-old', 'legacy-new'])).toBe(legacyFloor);
    const other = { ...link, discordChannelId: 'another-link' };
    await store.channelCursorStart(other, []);
    await store.channelCursorSet(other, Math.floor(Date.now() / 1000) + 120);
    await connection.end();
    connection = postgres(url, { max: 1 }); store = new PostgresMappingStore(connection, testTenant);
    expect(await store.channelCursorStart(link, ['rotated-stream'])).toBe(legacyFloor);
    const { community, folded } = bootstrapFixture(fixture);
    const channel = channelsView(community, folded)[0];
    const client = new ConcordClient(community, { replayRelays: ['synthetic'],
      enumerateRelay: async (_url, filter) => fixture.moderatorDeleteEvent.created_at >= filter.since! && fixture.moderatorDeleteEvent.created_at <= filter.until! ? [fixture.moderatorDeleteEvent.id] : [],
      fetchRelay: async (_url, ids) => ids.includes(fixture.moderatorDeleteEvent.id) ? [fixture.moderatorDeleteEvent] : [],
      query: async () => [fixture.moderatorDeleteEvent], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
    client.folded = folded;
    const deleted: string[] = [];
    const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
      send: async () => 'checkpoint-target', delete: async (_link, id, check) => { check?.(); deleted.push(id); },
      edit: async () => {}, react: async () => {}, unreact: async () => {}, sendTyping: async () => {},
    }, { resolve: async name => ({ name }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
    await store.insert({ discordMessageId: 'checkpoint-target', discordChannelId: link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: channel.idHex, communityId: community.idHex, origin: 'concord', authorRef: fixture.expected.member, partIndex: 0 });
    const replay = await client.backfillChannel(channel, await store.channelCursorStart(link, ['rotated-stream']) - 60);
    for (const chat of replay.chats) await router.onConcordChat(chat, link);
    expect(deleted).toEqual(['checkpoint-target']);

    await store.channelCursorSet(link, legacyFloor + 60);
    expect(await store.channelCursorStart(link, ['rotated-stream'])).toBe(legacyFloor + 60);
    const fresh = { ...link, discordGuildId: 'fresh-guild' };
    const floor = await store.channelCursorStart(fresh, []);
    expect(floor).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 1);
    await connection.end();
    connection = postgres(url, { max: 1 }); store = new PostgresMappingStore(connection, testTenant);
    expect(await store.channelCursorStart(fresh, ['new-epoch'])).toBe(floor);
    await connection.end();
  });

  it('makes concurrent actor capacity decisions atomic and duplicate retries free', async () => {
    const store = new PostgresMappingStore(sql, tenant + '-capacity');
    const half = Math.floor(MAX_PENDING_DELETES_PER_ACTOR / 2) + 1;
    const first = Array.from({ length: half }, (_, i) => pending(`first-${i}`));
    const second = Array.from({ length: half }, (_, i) => pending(`second-${i}`));
    const results = await Promise.allSettled([store.saveDeletes(link, first), store.saveDeletes(link, second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const held = await store.pendingDeletes(link);
    expect(held).toHaveLength(half);
    await store.saveDeletes(link, held);
    expect(await store.pendingDeletes(link)).toHaveLength(half);
    expect(await store.pendingDeletes({ ...link, discordChannelId: 'another-channel' })).toEqual([]);
    expect(await store.pendingDeletes({ ...link, discordGuildId: 'another-guild' })).toEqual([]);
  });

  it('refuses a full-link overflow without evicting old actions or partially accepting a batch', async () => {
    const store = new PostgresMappingStore(sql, tenant + '-link-cap');
    const rows = Array.from({ length: MAX_PENDING_DELETES_PER_LINK }, (_, i) => pending(`held-${i}`, `actor-${Math.floor(i / MAX_PENDING_DELETES_PER_ACTOR)}`));
    await store.saveDeletes(link, rows);
    await expect(store.saveDeletes(link, [pending('overflow', 'another-actor')])).rejects.toThrow('capacity');
    expect(await store.pendingDeletes(link)).toHaveLength(MAX_PENDING_DELETES_PER_LINK);
    expect(await store.pendingDeletes(link, 'overflow')).toEqual([]);
  });
});
it('disposes expired/carrier replay and unresolved overflow without consuming actionable capacity',async()=>{
 const store=new PostgresMappingStore(sql,tenant+'-classes');
 const author='a'.repeat(64), source=Math.floor(Date.now()/1000);
 const unresolved=(id:string)=>({...pending(id,author),actionClass:'unresolved' as const,sourceWrapCreatedAt:source});
 const expired={...unresolved('expired'),sourceWrapCreatedAt:source-8*86400};
 expect((await store.saveDeletes(link,[expired])).disposedExpired).toBe(1);
 expect((await store.saveDeletes(link,[{...expired,createdAtMs:Date.now()+100}])).disposedExpired).toBe(1);
 const intake=await store.saveDeletes(link,Array.from({length:1025},(_,i)=>unresolved(`quarantine-${i}`)));
 expect(intake.stored).toBe(1024);expect(intake.disposedCapacity).toBe(1);
 const action={...expired,deleteRumorId:'durable-action',targetRumorId:'durable-action',actionClass:'actionable' as const};
 await store.saveDeletes(link,[action]);
 expect((await store.pendingDeletes(link,'durable-action'))[0].expiresAtMs).toBeUndefined();
 expect((await store.dueDeletes(link))).toHaveLength(128);
 await store.retryDelete(link,action);
 expect(await store.dueDeletes(link,'durable-action')).toHaveLength(1);
 await store.wakeDeletes(link);
 expect((await store.pendingDeletes(link,'durable-action'))[0].attempts).toBe(1);
});

it('retains a saved action when its subsequent Postgres read fails', async () => {
  const { community, folded } = bootstrapFixture(fixture);
  const channel = channelsView(community, folded)[0];
  const client = new ConcordClient(community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
  client.folded = folded;
  const store = new PostgresMappingStore(sql, tenant + '-read-failure');
  await store.insert({ discordMessageId: 'read-failure-target', discordChannelId: link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: channel.idHex, communityId: community.idHex, origin: 'concord', authorRef: fixture.expected.member, partIndex: 0 });
  const due = store.dueDeletes.bind(store);
  store.dueDeletes = async () => { await sql`SELECT 1 / 0`; return []; };
  const deleted: string[] = [];
  const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
    send: async () => 'unused', delete: async (_link, id, check) => { check?.(); deleted.push(id); },
    edit: async () => {}, react: async () => {}, unreact: async () => {}, sendTyping: async () => {},
  }, { resolve: async name => ({ name }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
  const deletion = (await openChatBatch([fixture.moderatorDeleteEvent], channel))[0];
  await expect(router.onConcordChat(deletion, link)).resolves.toEqual([]);
  expect((await store.pendingDeletes(link))[0].actionClass).toBe('actionable');
  store.dueDeletes = due;
  await router.retryPendingDeletes(link, true);
  expect(deleted).toEqual(['read-failure-target']);
  expect(await store.pendingDeletes(link)).toEqual([]);
});
