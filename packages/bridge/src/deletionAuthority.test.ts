import { describe, expect, it } from 'bun:test';
import { buildGrantEdition, buildRumor, bytesToHex, channelBindingTags, channelsView, citationToTag, controlGroups, currentControlWriteGroup, foldControlState, grantLocator, hex32, openChatBatch, openControlWraps, openWrap, parseEdition, sealEdition, sealRumor, wrapSeal } from '@armada-bridge/concord-core';
import type { ChannelV2, OpenedChat, StreamSigner } from '@armada-bridge/concord-core';
import { generateSecretKey } from 'nostr-tools/pure';
import { bootstrapFixture } from '../../../scripts/fixtures/community-bootstrap';
import { moderationFixture } from '../../../scripts/fixtures/moderation-events';
import fixture from '../../../test-fixtures/concord/community-interop.json';
import { deliverConcordChat } from './concord/delivery';
import { ConcordClient } from './concord/client';
import { localIdentity } from './concord/signer';
import { PuppetCache } from './puppets';
import { BridgeRouter, MemoryMappingStore } from './router';
import { DeletionIntakeError, PromotionDeletionIntakeError } from './deletionPolicy';
import type { ChannelLink, MappingStore, WebhookSender } from './router';

export function deletionHarness(store: MappingStore = new MemoryMappingStore(), before: () => Promise<void> = async () => {}) {
  const { community, folded } = bootstrapFixture(fixture);
  const pool = { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} };
  const client = new ConcordClient(community, pool, localIdentity(generateSecretKey())); client.folded = folded;
  const channel = channelsView(community, folded)[0];
  const link: ChannelLink = { communityId: community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'synthetic-guild', discordChannelId: 'synthetic-channel', enabled: true };
  const puppets = new PuppetCache('ab'.repeat(32));
  const deleted: string[] = [], unreacted: string[] = [];
  let sequence = 0;
  const webhooks: WebhookSender = {
    send: async () => `message-${sequence++}`, edit: async () => {}, react: async () => {}, sendTyping: async () => {},
    delete: async (_link, id, authorize) => { authorize?.(); deleted.push(id); },
    unreact: async (_link, id, _emoji, authorize) => { authorize?.(); unreacted.push(id); },
  };
  const create = () => new BridgeRouter(client, puppets, store, webhooks, { resolve: async pk => ({ name: pk }) }, { applicationId: 'synthetic-app', webhookIds: new Set() }, { beforeSideEffect: before });
  return { community, client, channel, link, store, puppets, deleted, unreacted, webhooks, create, router: create() };
}
const opened = async (event: typeof fixture.chatEvent, channel: ChannelV2) => (await openChatBatch([event], channel))[0];

describe('Concord deletion authority at the Discord boundary', () => {
  it('contains ordinary mirror failures but still rejects nondurable signed deletions', async () => {
    const h = deletionHarness();
    const send = h.webhooks.send;
    h.webhooks.send = async () => { throw new Error('Discord unavailable'); };
    const errors: unknown[] = [];
    const message = await opened(fixture.chatEvent, h.channel);
    expect(await deliverConcordChat(h.router, message, h.link, error => errors.push(error))).toEqual([]);
    expect(errors).toHaveLength(1);
    h.webhooks.send = send;
    expect(await deliverConcordChat(h.router, message, h.link, error => errors.push(error))).toHaveLength(1);
    h.store.saveDeletes = async () => { throw new Error('storage unavailable'); };
    await expect(deliverConcordChat(h.router, await opened(fixture.moderatorDeleteEvent, h.channel), h.link, error => errors.push(error))).rejects.toThrow('storage unavailable');
    expect(errors).toHaveLength(1);
  });

  for (const [name, message, deletion] of [
    ['owner target', fixture.ownerChatEvent, fixture.moderatorDeletesOwnerEvent],
    ['admin target', fixture.adminChatEvent, fixture.moderatorDeletesAdminEvent],
    ['uncited moderator', fixture.chatEvent, fixture.uncitedModeratorDeleteEvent],
    ['cited actor without message permission', fixture.chatEvent, fixture.citedUnprivilegedDeleteEvent],
  ] as const) it(`refuses ${name} with signed client vectors`, async () => {
    const h = deletionHarness();
    await h.router.onConcordChat(await opened(message, h.channel), h.link);
    await h.router.onConcordChat(await opened(deletion, h.channel), h.link);
    expect(h.deleted).toEqual([]);
  });

  it('honors the same moderator with a satisfied citation over an ordinary member', async () => {
    const h = deletionHarness();
    const ids = await h.router.onConcordChat(await opened(fixture.chatEvent, h.channel), h.link);
    await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link);
    expect(h.deleted).toEqual(ids);
  });

  it('scopes a delete to its community, Concord channel and Discord link', async () => {
    for (const field of ['communityId', 'concordChannelId', 'discordChannelId'] as const) {
      const h = deletionHarness();
      await h.store.insert({ discordMessageId: 'foreign', discordChannelId: h.link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: h.channel.idHex, communityId: h.community.idHex, origin: 'concord', authorRef: fixture.expected.member, partIndex: 0, [field]: 'foreign' });
      await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link);
      expect(h.deleted).toEqual([]);
    }
  });

  it('rechecks current authority after an awaited forwarding guard', async () => {
    let revoke = false;
    const h = deletionHarness(undefined, async () => { if (revoke) h.client.folded = { ...h.client.folded!, banned: new Set([fixture.expected.moderator]) }; });
    await h.router.onConcordChat(await opened(fixture.chatEvent, h.channel), h.link);
    revoke = true;
    await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link);
    expect(h.deleted).toEqual([]);
  });

  it('resolves Discord-origin target rank through the link puppet', async () => {
    const h = deletionHarness();
    const puppet = h.puppets.get('80351110224678912');
    const state = h.client.folded!;
    // The puppet holds the same role as the moderator; a Discord user id is
    // not a Nostr actor and would otherwise look like an unranked member.
    state.roster.grants.push({ ...state.roster.grants.find(grant => grant.member === fixture.expected.moderator)!, member: puppet.pk });
    await h.store.insert({ discordMessageId: 'discord-original', discordChannelId: h.link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: h.channel.idHex, communityId: h.community.idHex, origin: 'discord', authorRef: '80351110224678912', partIndex: 0 });
    await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link);
    expect(h.deleted).toEqual([]);
  });

  it('retains a future citation for a fresh router after its grant is folded', async () => {
    const f = await moderationFixture();
    const client = new ConcordClient(f.community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
    const initial = openControlWraps(f.policy.controlEvents, controlGroups(f.community));
    client.folded = foldControlState(initial, f.community.id, f.owner.pk);
    const grantId = grantLocator(f.community.id, hex32(f.moderator.pk));
    const previous = client.folded.heads.get(bytesToHex(grantId))!;
    const next = await sealEdition(buildGrantEdition(f.community.id, { member: f.moderator.pk, roleIds: [f.roleId] }, { actorPubkey: f.owner.pk, version: previous.version + 1n, prevHash: previous.hash }), currentControlWriteGroup(f.community), f.owner.signer);
    const future = parseEdition(openWrap(next, currentControlWriteGroup(f.community)));
    const channel = channelsView(f.community, client.folded)[0];
    const rumor = buildRumor({ pubkey: f.moderator.pk, kind: 5, content: '', tags: [...channelBindingTags(channel.idHex, 0n), ['e', f.allowedRumorId], citationToTag({ entityId: grantId, version: future.version, editionHash: future.selfHash })], ms: Date.now() });
    const deletion = (await openChatBatch([wrapSeal(await sealRumor(rumor, 20013, channel.current.group, f.moderator.signer), channel.current.group)], channel))[0];
    const store = new MemoryMappingStore(); const deleted: string[] = [];
    const link: ChannelLink = { communityId: f.community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'g', discordChannelId: 'c', enabled: true };
    const webhook: WebhookSender = { send: async () => 'message', delete: async (_l,id,authorize) => { authorize?.(); deleted.push(id); }, unreact: async () => {}, react: async () => {}, edit: async () => {}, sendTyping: async () => {} };
    const create = () => new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, webhook, { resolve: async pk => ({ name: pk }) }, { applicationId: 'app', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
    await store.insert({ discordMessageId: 'message', discordChannelId: 'c', concordRumorId: f.allowedRumorId, concordChannelId: channel.idHex, communityId: f.community.idHex, origin: 'concord', authorRef: f.member.pk, partIndex: 0 });
    await create().onConcordChat(deletion, link);
    expect(deleted).toEqual([]);
    client.folded = foldControlState([...initial, future], f.community.id, f.owner.pk);
    await create().retryPendingDeletes(link,true);
    expect(deleted).toEqual(['message']);
  });
});

async function signedReactionHarness() {
  const f = await moderationFixture();
  const client = new ConcordClient(f.community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey()));
  const controls = [...f.policy.controlEvents];
  const refold = () => { client.folded = foldControlState(openControlWraps(controls, controlGroups(f.community)), f.community.id, f.owner.pk); };
  refold();
  const channel = channelsView(f.community, client.folded)[0];
  const link: ChannelLink = { communityId: f.community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'g', discordChannelId: 'c', enabled: true };
  const store = new MemoryMappingStore();
  let failUnreact = false;
  const removed: string[] = [];
  const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
    send: async () => 'message', delete: async () => {}, edit: async () => {}, react: async () => {}, sendTyping: async () => {},
    unreact: async (_link, id, _emoji, authorize) => { authorize?.(); if (failUnreact) throw new Error('Discord unavailable'); removed.push(id); },
  }, { resolve: async name => ({ name }) }, { applicationId: 'app', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
  await router.onConcordChat((await openChatBatch([f.allowed], channel))[0], link);
  const event = async (actor: { pk: string; signer: StreamSigner }, kind: number, tags: string[][], content = ''): Promise<OpenedChat> => {
    const rumor = buildRumor({ pubkey: actor.pk, kind, content, tags: [...channelBindingTags(channel.idHex, 0n), ...tags], ms: Date.now() });
    return (await openChatBatch([wrapSeal(await sealRumor(rumor, 20013, channel.current.group, actor.signer), channel.current.group)], channel))[0];
  };
  const deletion = async (target: string, cited = true) => {
    const grant = grantLocator(f.community.id, hex32(f.moderator.pk));
    const head = client.folded!.heads.get(bytesToHex(grant))!;
    return event(f.moderator, 5, [['e', target], ...(cited ? [citationToTag({ entityId: grant, version: head.version, editionHash: head.hash })] : [])]);
  };
  return { f, client, controls, refold, channel, link, store, removed, router, event, deletion, fail: (value: boolean) => { failUnreact = value; } };
}

describe('signed reaction deletion', () => {
  for (const rank of ['owner', 'equal']) it(`refuses a moderator acting on the ${rank} reactor`, async () => {
    const h = await signedReactionHarness();
    const reactor = rank === 'owner' ? h.f.owner : localIdentity(generateSecretKey());
    if (rank === 'equal') {
      h.controls.push(await sealEdition(buildGrantEdition(h.f.community.id, { member: reactor.pk, roleIds: [h.f.roleId] }, { actorPubkey: h.f.owner.pk, version: 1n }), currentControlWriteGroup(h.f.community), h.f.owner.signer));
      h.refold();
    }
    const reaction = await h.event(reactor, 7, [['e', h.f.allowedRumorId]], '👍');
    await h.router.onConcordChat(reaction, h.link);
    await h.router.onConcordChat(await h.deletion(reaction.rumorId), h.link);
    expect(h.removed).toEqual([]);
    expect(await h.store.reactionByRumorId(reaction.rumorId)).toBeDefined();
  });

  it('requires a citation, then retains a failed external removal for retry', async () => {
    const h = await signedReactionHarness();
    const reaction = await h.event(h.f.member, 7, [['e', h.f.allowedRumorId]], '👍');
    await h.router.onConcordChat(reaction, h.link);
    await h.router.onConcordChat(await h.deletion(reaction.rumorId, false), h.link);
    expect(h.removed).toEqual([]);
    h.fail(true);
    await h.router.onConcordChat(await h.deletion(reaction.rumorId), h.link);
    expect(await h.store.reactionByRumorId(reaction.rumorId)).toBeDefined();
    expect(await h.store.pendingDeletes(h.link)).toHaveLength(1);
    h.fail(false);
    await h.router.retryPendingDeletes(h.link,true);
    expect(h.removed).toEqual(['message']);
    expect(await h.store.reactionByRumorId(reaction.rumorId)).toBeUndefined();
    expect(await h.store.pendingDeletes(h.link)).toEqual([]);
  });

  it('never removes a reaction through another Discord link', async () => {
    const h = await signedReactionHarness();
    const reaction = await h.event(h.f.member, 7, [['e', h.f.allowedRumorId]], '👍');
    await h.router.onConcordChat(reaction, h.link);
    await h.router.onConcordChat(await h.deletion(reaction.rumorId), { ...h.link, discordChannelId: 'another-channel' });
    expect(h.removed).toEqual([]);
    expect(await h.store.reactionByRumorId(reaction.rumorId)).toBeDefined();
  });
});

it('propagates pending deletion storage failures', async () => {
  class UnavailableStore extends MemoryMappingStore {
    override async saveDeletes(): Promise<never> { throw new Error('storage unavailable'); }
  }
  const h = deletionHarness(new UnavailableStore());
  await expect(h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link)).rejects.toThrow('storage unavailable');
  expect(h.deleted).toEqual([]);
});

it('waits for its own mapped copy without deleting another link copy', async () => {
  const h = deletionHarness();
  const row = { discordMessageId: 'foreign-copy', discordChannelId: 'foreign-channel', concordRumorId: fixture.expected.message.id, concordChannelId: h.channel.idHex, communityId: h.community.idHex, origin: 'concord' as const, authorRef: fixture.expected.member, partIndex: 0 };
  await h.store.insert(row);
  await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent, h.channel), h.link);
  expect(h.deleted).toEqual([]);
  expect(await h.store.pendingDeletes(h.link)).toHaveLength(1);
  await h.store.insert({ ...row, discordMessageId: 'own-copy', discordChannelId: h.link.discordChannelId });
  await h.router.retryPendingDeletes(h.link,true);
  expect(h.deleted).toEqual(['own-copy']);
  expect(await h.store.pendingDeletes(h.link)).toEqual([]);
});

it('durably accepts a single sealed deletion with hundreds of valid target identifiers', async () => {
  const h = await signedReactionHarness();
  const grant = grantLocator(h.f.community.id, hex32(h.f.moderator.pk));
  const head = h.client.folded!.heads.get(bytesToHex(grant))!;
  const targets = Array.from({ length: 300 }, (_, i) => ['e', (i + 1).toString(16).padStart(64, '0')]);
  const deletion = await h.event(h.f.moderator, 5, [...targets, citationToTag({ entityId: grant, version: head.version, editionHash: head.hash })]);
  await h.router.onConcordChat(deletion, h.link);
  expect(await h.store.pendingDeletes(h.link)).toHaveLength(300);
});

it('bounds replay work without starving an authorized deletion behind denied actions', async () => {
  const h = deletionHarness();
  await h.store.insert({ discordMessageId: 'owner-copy', discordChannelId: h.link.discordChannelId, concordRumorId: fixture.expected.ownerMessageId, concordChannelId: h.channel.idHex, communityId: h.community.idHex, origin: 'concord', authorRef: fixture.expected.owner, partIndex: 0 });
  await h.store.insert({ discordMessageId: 'member-copy', discordChannelId: h.link.discordChannelId, concordRumorId: fixture.expected.message.id, concordChannelId: h.channel.idHex, communityId: h.community.idHex, origin: 'concord', authorRef: fixture.expected.member, partIndex: 0 });
  const denied = await opened(fixture.moderatorDeletesOwnerEvent, h.channel);
  const citation = denied.tags.find(tag => tag[0] === 'vac')!;
  await h.store.saveDeletes(h.link, Array.from({ length: 128 }, (_, i) => ({ deleteRumorId: `held-${i}`, targetRumorId: fixture.expected.ownerMessageId, author: denied.author, citation, createdAtMs: Date.now() - 1000 + i })));
  const allowed = await opened(fixture.moderatorDeleteEvent, h.channel);
  await h.store.saveDeletes(h.link, [{ deleteRumorId: allowed.rumorId, targetRumorId: fixture.expected.message.id, author: allowed.author, citation: allowed.tags.find(tag => tag[0] === 'vac'), createdAtMs: Date.now() - 871 }]);
  await h.router.retryPendingDeletes(h.link);
  expect(h.deleted).toEqual([]);
  await h.router.retryPendingDeletes(h.link);
  expect(h.deleted).toEqual(['member-copy']);
});

// This is a deliberate policy limit, not a storage outage: retain evidence of
// why silently evicting unknown targets would trade away future self-deletes.
it('keeps actionable self-deletes independent of a full unknown-target allocation', async () => {
  const h = await signedReactionHarness();
  for (let batch = 0; batch < 4; batch++) {
    const tags = Array.from({ length: 256 }, (_, i) => ['e', (batch * 256 + i + 100_000).toString(16).padStart(64, '0')]);
    await h.router.onConcordChat(await h.event(h.f.member, 5, tags), h.link);
  }
  await h.router.retryPendingDeletes(h.link);
  expect(await h.store.pendingDeletes(h.link)).toHaveLength(1024);
  const selfDelete = await h.event(h.f.member, 5, [['e', h.f.allowedRumorId]]);
  await expect(h.router.onConcordChat(selfDelete, h.link)).resolves.toEqual([]);
});

it('contains a read failure after durable intake without rejecting deletion delivery', async () => {
  const h = deletionHarness();
  const inventory=h.store.pendingDeletes.bind(h.store);
  h.store.pendingDeletes = h.store.dueDeletes = async () => { throw new Error('read unavailable after save'); };
  await expect(h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent,h.channel),h.link)).resolves.toEqual([]);
  expect(await inventory(h.link)).toHaveLength(1);
});
it('retains actionable effects through long outages and authority loss, then rechecks current authority',async()=>{
  let now=Date.now();
  const store=new MemoryMappingStore(()=>now), h=deletionHarness(store);
  await h.router.onConcordChat(await opened(fixture.chatEvent,h.channel),h.link);
  h.webhooks.delete=async()=>{throw Object.assign(new Error('missing Manage Messages'),{code:50013});};
  await h.router.onConcordChat(await opened(fixture.moderatorDeleteEvent,h.channel),h.link);
  expect((await store.pendingDeletes(h.link))[0].actionClass).toBe('actionable');
  const folded=h.client.folded!;
  h.client.folded={...folded,banned:new Set([fixture.expected.moderator])};
  now+=8*86400_000;
  await h.router.retryPendingDeletes(h.link);
  expect((await store.pendingDeletes(h.link))[0].actionClass).toBe('actionable');
  h.webhooks.delete=async(_link,id,authorize)=>{authorize?.();h.deleted.push(id);};
  h.client.folded=folded;
  await h.router.retryPendingDeletes(h.link,true);
  expect(h.deleted).toHaveLength(1);
  expect(await store.pendingDeletes(h.link)).toEqual([]);
});
it('reports original source as a replay gap on promotion overflow and accepts replay after capacity is freed',async()=>{
 const h=deletionHarness();
 const deletion=await opened(fixture.moderatorDeleteEvent,h.channel);
 const citation=deletion.tags.find(tag=>tag[0]==='vac');
 const source=Math.floor(Date.now()/1000)-100;
 for(let i=0;i<1024;i++) await h.store.saveDeletes(h.link,[{deleteRumorId:`capacity-${i}`,targetRumorId:`missing-${i}`,author:deletion.author,createdAtMs:Date.now(),sourceWrapCreatedAt:source,actionClass:'actionable',nextAttemptAtMs:Date.now()+3600_000}]);
 await h.store.saveDeletes(h.link,[{deleteRumorId:deletion.rumorId,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:Date.now(),sourceWrapCreatedAt:source}]);
 await h.store.insert({discordMessageId:'promoted-target',discordChannelId:h.link.discordChannelId,concordRumorId:fixture.expected.message.id,concordChannelId:h.channel.idHex,communityId:h.community.idHex,origin:'concord',authorRef:fixture.expected.member,partIndex:0});
 // Target wake goes straight to the newly resolvable action despite retry timers.
 let gap: any;
 try {await h.router.retryPendingDeletes(h.link);} catch(error){gap=error;}
 expect(gap?.durable).toBe(false);expect(gap?.repairFloor).toBe(source);expect(gap?.link).toEqual(h.link);
 expect((await h.store.pendingDeletes(h.link,fixture.expected.message.id))[0].actionClass).toBe('unresolved');
 await h.store.completeDelete(h.link,'capacity-0','missing-0');
 await h.create().onConcordChat({...deletion,sourceWrapCreatedAt:source} as OpenedChat,h.link);
 expect(h.deleted).toEqual(['promoted-target']);
 expect(await h.store.pendingDeletes(h.link,fixture.expected.message.id)).toEqual([]);
});

it('drains accepted actions past more than one batch of blocked promotions', async () => {
 let now=Date.now();
 const store=new MemoryMappingStore(()=>now), h=deletionHarness(store);
 const deletion=await opened(fixture.moderatorDeleteEvent,h.channel), citation=deletion.tags.find(tag=>tag[0]==='vac');
 const source=Math.floor(now/1000)-1000;
 await store.insert({discordMessageId:'queue-target',discordChannelId:h.link.discordChannelId,concordRumorId:fixture.expected.message.id,concordChannelId:h.channel.idHex,communityId:h.community.idHex,origin:'concord',authorRef:fixture.expected.member,partIndex:0});
 const row=(id:string, actionClass:'unresolved'|'actionable', offset:number)=>({deleteRumorId:id,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:now,sourceWrapCreatedAt:source+offset,actionClass,nextAttemptAtMs:actionClass==='unresolved'?now-1000:now});
 await store.saveDeletes(h.link,Array.from({length:1024},(_,i)=>row(`accepted-${i}`,'actionable',0)));
 await store.saveDeletes(h.link,Array.from({length:129},(_,i)=>row(`waiting-${i}`,'unresolved',129-i)));
 let gap:any;
 try {await h.router.retryPendingDeletes(h.link);} catch(error) {gap=error;}
 expect(gap?.durable).toBe(false); expect(gap?.repairFloor).toBe(source+2); expect(gap?.link).toEqual(h.link);
 try {await h.router.retryPendingDeletes(h.link);} catch {}
 expect(h.deleted.length).toBeGreaterThan(0);
 for(let i=0;i<20 && (await store.pendingDeletes(h.link)).length;i++) { now+=20_000; try {await h.router.retryPendingDeletes(h.link);} catch {} }
 expect(await store.pendingDeletes(h.link)).toEqual([]);
 expect(h.deleted).toHaveLength(1153);
});

it('reports a promotion storage outage across expiry and recovers via replay', async () => {
 let now=Date.now();
 const store=new MemoryMappingStore(()=>now), h=deletionHarness(store);
 const deletion=await opened(fixture.moderatorDeleteEvent,h.channel), citation=deletion.tags.find(tag=>tag[0]==='vac');
 const source=Math.floor(now/1000)-6*86400;
 await store.saveDeletes(h.link,[{deleteRumorId:deletion.rumorId,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:now,sourceWrapCreatedAt:source,nextAttemptAtMs:now-1000},
  {deleteRumorId:'already-accepted',targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:now,sourceWrapCreatedAt:source,actionClass:'actionable'}]);
 await store.insert({discordMessageId:'outage-target',discordChannelId:h.link.discordChannelId,concordRumorId:fixture.expected.message.id,concordChannelId:h.channel.idHex,communityId:h.community.idHex,origin:'concord',authorRef:fixture.expected.member,partIndex:0});
 const promote=store.promoteDelete.bind(store);
 store.promoteDelete=async()=>{throw new DeletionIntakeError('storage unavailable');};
 let gap:any;
 try {await h.router.retryPendingDeletes(h.link);} catch(error) {gap=error;}
 expect(gap?.durable).toBe(false); expect(gap?.repairFloor).toBe(source); expect(gap?.link).toEqual(h.link);
 expect((await store.pendingDeletes(h.link))[0].actionClass).toBe('unresolved');
 expect(h.deleted).toEqual(['outage-target']);
 now+=2*86400_000; store.promoteDelete=promote;
 await h.router.retryPendingDeletes(h.link);
 expect(await store.pendingDeletes(h.link)).toEqual([]); expect(h.deleted).toEqual(['outage-target']);
 await h.create().onConcordChat({...deletion,sourceWrapCreatedAt:Math.floor(now/1000)} as OpenedChat,h.link);
 expect(h.deleted).toEqual(['outage-target','outage-target']);
});

it('drains accepted actions despite repeated fold wakeups of blocked promotions', async () => {
 const now=Date.now(), store=new MemoryMappingStore(()=>now), h=deletionHarness(store);
 const deletion=await opened(fixture.moderatorDeleteEvent,h.channel), citation=deletion.tags.find(tag=>tag[0]==='vac');
 const source=Math.floor(now/1000)-1000;
 await store.insert({discordMessageId:'wake-target',discordChannelId:h.link.discordChannelId,concordRumorId:fixture.expected.message.id,concordChannelId:h.channel.idHex,communityId:h.community.idHex,origin:'concord',authorRef:fixture.expected.member,partIndex:0});
 const row=(id:string, actionClass:'unresolved'|'actionable')=>({deleteRumorId:id,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:now,sourceWrapCreatedAt:source,actionClass,nextAttemptAtMs:actionClass==='unresolved'?now-1000:now});
 await store.saveDeletes(h.link,Array.from({length:129},(_,i)=>row(`wake-waiting-${i}`,'unresolved')));
 await store.saveDeletes(h.link,Array.from({length:1024},(_,i)=>row(`wake-accepted-${i}`,'actionable')));
 for(let i=0;i<3;i++) { try {await h.router.retryPendingDeletes(h.link,true);} catch {} }
 expect(h.deleted.length).toBeGreaterThan(0);
 for(let i=0;i<15 && (await store.pendingDeletes(h.link)).length;i++) { try {await h.router.retryPendingDeletes(h.link,true);} catch {} }
 expect(await store.pendingDeletes(h.link)).toEqual([]);
 expect(h.deleted).toHaveLength(1153);
});

it('rechecks the stored deletion epoch against a rotation before retrying', async () => {
  const h = deletionHarness();
  const grant = bytesToHex(grantLocator(h.community.id, hex32(fixture.expected.moderator)));
  const full = h.client.folded!;
  h.client.folded = foldControlState(openControlWraps(fixture.controlEvents, controlGroups(h.community)).filter(e => bytesToHex(e.entityId) !== grant), h.community.id, h.community.owner);
  await h.router.onConcordChat(await opened(fixture.chatEvent, h.channel), h.link);
  const deletion = await opened(fixture.moderatorDeleteEvent, h.channel);
  await h.router.onConcordChat(deletion, h.link);
  expect(await h.store.pendingDeletes(h.link)).toHaveLength(1);
  h.client.folded = full;
  const retired = { ...h.channel, streams: h.channel.streams.map(s => ({ ...s, retiredAt: deletion.createdAt - 1 })) };
  h.client.channel = () => retired;
  await h.router.retryPendingDeletes(h.link, true);
  expect(h.deleted).toEqual([]);
});

it('rechecks a queued chat after adopting a retirement cutoff', async () => {
  const h = deletionHarness();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let sends = 0;
  h.webhooks.send = async () => { sends++; if (sends === 1) { entered(); await blocked; } return `synthetic-${sends}`; };
  const first = await opened(fixture.chatEvent, h.channel);
  const queued = await opened(fixture.ownerChatEvent, h.channel);
  const a = h.router.onConcordChat(first, h.link); await started;
  const b = h.router.onConcordChat(queued, h.link);
  h.client.channel = () => ({ ...h.channel, streams: h.channel.streams.map(s => ({ ...s, retiredAt: queued.createdAt - 1 })) });
  release(); await a;
  expect(await b).toEqual([]);
  expect(sends).toBe(1);
});

it('propagates original deletion floor when an ordinary message creates its mapping', async()=>{
 const h=deletionHarness();
 const deletion=await opened(fixture.moderatorDeleteEvent,h.channel), source=Math.floor(Date.now()/1000)-1000;
 const citation=deletion.tags.find(tag=>tag[0]==='vac');
 await h.store.saveDeletes(h.link,[{deleteRumorId:deletion.rumorId,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:Date.now(),sourceWrapCreatedAt:source}]);
 h.store.promoteDelete=async()=>{throw new Error('synthetic promotion outage');};
 let ordinaryErrors=0, result:unknown;
 try {await deliverConcordChat(h.router,await opened(fixture.chatEvent,h.channel),h.link,()=>{ordinaryErrors++;});} catch(error) {result=error;}
 expect(result).toBeInstanceOf(PromotionDeletionIntakeError);
 expect((result as PromotionDeletionIntakeError).repairFloor).toBe(source);
 expect(ordinaryErrors).toBe(0);
});

it('propagates original deletion floor when a reaction creates its mapping', async()=>{
 const h=await signedReactionHarness();
 const reaction=await h.event(h.f.member,7,[['e',h.f.allowedRumorId]],'👍');
 const deletion=await h.deletion(reaction.rumorId), source=Math.floor(Date.now()/1000)-1000;
 const citation=deletion.tags.find(tag=>tag[0]==='vac');
 await h.store.saveDeletes(h.link,[{deleteRumorId:deletion.rumorId,targetRumorId:reaction.rumorId,author:deletion.author,citation,createdAtMs:Date.now(),sourceWrapCreatedAt:source}]);
 h.store.promoteDelete=async()=>{throw new Error('synthetic promotion outage');};
 let result:unknown;
 try {await deliverConcordChat(h.router,reaction,h.link,()=>{});} catch(error) {result=error;}
 expect(result).toBeInstanceOf(PromotionDeletionIntakeError);
 expect((result as PromotionDeletionIntakeError).repairFloor).toBe(source);
});

it('propagates a promotion failure from Discord-origin message mapping', async()=>{
 const h=deletionHarness(), deletion=await opened(fixture.moderatorDeleteEvent,h.channel);
 const source=Math.floor(Date.now()/1000)-1000, citation=deletion.tags.find(tag=>tag[0]==='vac');
 await h.store.saveDeletes(h.link,[{deleteRumorId:deletion.rumorId,targetRumorId:fixture.expected.message.id,author:deletion.author,citation,createdAtMs:Date.now(),sourceWrapCreatedAt:source}]);
 h.store.promoteDelete=async()=>{throw new Error('synthetic promotion outage');};
 h.client.sendChat=async()=>({rumor:{id:fixture.expected.message.id}} as never);
 const message={id:'discord-message',channelId:h.link.discordChannelId,guildId:h.link.discordGuildId,author:{id:'80351110224678912',display:'Person',bot:false},content:'synthetic'};
 let result:unknown;
 try {await h.router.onDiscordMessage(message,h.link);} catch(error) {result=error;}
 expect(result).toBeInstanceOf(PromotionDeletionIntakeError);
 expect((result as PromotionDeletionIntakeError).repairFloor).toBe(source);
});
