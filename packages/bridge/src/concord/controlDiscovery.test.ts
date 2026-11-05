import { expect, it } from 'bun:test';
import { mintCommunity, buildChannelEdition, currentControlWriteGroup, sealEdition, bytesToHex, buildRumor, channelBindingTags, sealRumor, wrapSeal } from '@armada-bridge/concord-core';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { localIdentity } from './signer';
import { ConcordClient } from './client';
import { LinkDelivery } from './linkDelivery';
import { BridgeManager } from '../../../portal/src/manager';
import type { RelayLike } from './pool';

// A capped successful REQ omits the sole Channel edition, while its root
// stream's key is held. Payload inventories cannot discover that author.
async function fixture(future = false) {
  const owner = localIdentity(generateSecretKey()), relays = ['wss://a.example', 'wss://b.example'];
  const { community } = mintCommunity('Synthetic discovery', owner.pk, relays), id = new Uint8Array(32).fill(17);
  community.privateChannels.push({ id, key: generateSecretKey(), epoch: 1n, name: 'Held channel' });
  let edition = await sealEdition(buildChannelEdition(id, { name: 'Public channel', private: false }, { actorPubkey: owner.pk, version: 1n }), currentControlWriteGroup(community), owner.signer);
  if (future) edition = finalizeEvent({ ...edition, created_at: Math.floor(Date.now() / 1000) + 3600 }, currentControlWriteGroup(community).sk);
  let failed = false;
  const requested: string[] = [], effects: string[] = [];
  const decoy = await sealEdition(buildChannelEdition(new Uint8Array(32).fill(19), { name: 'Other channel', private: false }, { actorPubkey: owner.pk, version: 1n }), currentControlWriteGroup(community), owner.signer);
  const later = await sealEdition(buildChannelEdition(new Uint8Array(32).fill(20), { name: 'Later channel', private: false }, { actorPubkey: owner.pk, version: 1n }), currentControlWriteGroup(community), owner.signer);
  const events = [edition, decoy];
  let controlEvent: ((event: any) => void) | undefined;
  const pool: RelayLike & { urls: string[] } = {
    urls: relays, replayRelays: relays, query: async () => [decoy], publish: async () => {}, subscribe: (_filters, handlers) => { controlEvent = handlers.onEvent; return () => { controlEvent = undefined; }; }, close: async () => {},
    enumerateRelay: async (url, f) => { requested.push(url); if (failed && url === relays[1] && f.authors!.includes(edition.pubkey)) throw new Error('source unavailable'); return events.filter(e => (url === relays[1] || e.id !== edition.id) && f.authors!.includes(e.pubkey) && e.created_at >= f.since! && (f.until === undefined || e.created_at <= f.until)).map(e => e.id); },
    fetchRelay: async (_url, ids) => events.filter(e => ids.includes(e.id)).slice(0, 1),
  };
  const complete = new ConcordClient(community, { ...pool, query: async () => [edition, decoy] }, owner);
  await complete.syncControl();
  const full = complete.channel(bytesToHex(id))!, root = full.streams.find(s => s.epoch === 0n)!;
  const at = Math.floor(Date.now() / 1000) - 120;
  const rumor = buildRumor({ pubkey: owner.pk, kind: 5, content: '', tags: [...channelBindingTags(bytesToHex(id), 0n), ['e', 'ab'.repeat(32)]], ms: at * 1000 });
  events.push(finalizeEvent({ ...wrapSeal(await sealRumor(rumor, 20013, root.group, owner.signer), root.group), created_at: at }, root.group.sk));
  const client = new ConcordClient(community, pool, owner); await client.syncControl();
  let snapshot: any = { ownerId: 'synthetic', epoch: 'synthetic', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, version: 0, activationFloor: 0, recoveryFloor: 0, deletionFloor: 0, repairFloor: 0, coverage: {}, ordinaryCoverage: {}, legacyBoundaries: {}, relays };
  const store = { deliverySnapshot: async () => snapshot, setDeliveryRelays: async () => snapshot,
    certifyDelivery: async (v: number, until: number, coverage: any, done: boolean) => { if (v !== snapshot.version) return false; snapshot = { ...snapshot, version: v + 1, certifiedUntil: until, coverage, repairFloor: done ? undefined : until + 1 }; return true; } };
  const lane = new LinkDelivery({ onError: () => {} });
  return { client, pool, store, lane, id: bytesToHex(id), requested, effects, lateControl: () => controlEvent?.(later), snapshot: () => snapshot, fail: (value: boolean) => { failed = value; } };
}

for (const runtime of ['standalone', 'portal'] as const) {
  it(`${runtime} discovers the omitted root stream despite capped control REQ before certifying signed deletion recovery`, async () => {
    const h = await fixture();
    expect(h.client.channel(h.id)!.streams.length).toBe(1);
    let channel = h.client.channel(h.id)!;
    const deliver = async (chat: any) => { h.effects.push(chat.rumorId); };
    const manager: any = Object.create(BridgeManager.prototype);
    const rb: any = { client: h.client, pool: h.pool, delivery: h.lane, deliveryStore: h.store, channel, link: { concordChannelIdHex: h.id }, router: {}, id: 'synthetic-discovery', deliveryRecoveryFloor: 0, unsubChat: () => {} };
    manager.deliverRoutedChat = async (_rb: any, chat: any) => deliver(chat);
    manager.subscribeChat = () => () => {};
    const repair = () => runtime === 'portal' ? manager.backfillMissed(rb) : h.client.repairDelivery(h.lane, {
      store: h.store, channel: () => channel, relays: () => h.pool.urls,
      refresh: () => { channel = h.client.channel(h.id)!; }, deliver,
    });
    h.fail(true);
    await expect(repair()).rejects.toThrow('source unavailable');
    expect(h.effects).toEqual([]); expect(h.snapshot().repairFloor).toBe(0); expect(h.snapshot().certifiedUntil).toBeUndefined();
    // The source recovers after partial startup discovery. Retry must repeat
    // control enumeration, rather than replaying the stable partial filter.
    h.fail(false); await repair();
    expect(h.client.channel(h.id)!.streams.length).toBe(2);
    expect(h.effects).toHaveLength(1); expect(h.snapshot().repairFloor).toBeUndefined();
    expect(h.snapshot().certifiedUntil).toBeGreaterThan(0); expect(h.requested).toContain(h.pool.urls[1]);
  });
}

it('an arriving signed control event invalidates coverage before the batched live refold runs', async () => {
  const h = await fixture(), unsubscribe = h.client.subscribeControl(() => {});
  let channel = h.client.channel(h.id)!, changed = false;
  const enumerate = h.pool.enumerateRelay!;
  h.pool.enumerateRelay = async (url, filter, opts) => {
    const ids = await enumerate(url, filter, opts);
    if (filter.authors!.includes(channel.current.group.pk) && !changed) { changed = true; h.lateControl(); }
    return ids;
  };
  try {
    await expect(h.client.repairDelivery(h.lane, { store: h.store, channel: () => channel, relays: () => h.pool.urls,
      refresh: () => { channel = h.client.channel(h.id)!; }, deliver: async chat => { h.effects.push(chat.rumorId); },
    })).rejects.toThrow();
    expect(h.lane.gapFloor).toBe(0);
    expect(h.effects).toEqual([]); expect(h.snapshot().repairFloor).toBe(0);
    expect(h.snapshot().certifiedUntil).toBeUndefined();
  } finally { unsubscribe(); }
});

it('a signed future control wrapper discovers the root stream holding a settled past deletion', async () => {
  const h = await fixture(true); let channel = h.client.channel(h.id)!;
  await h.client.repairDelivery(h.lane, { store: h.store, channel: () => channel, relays: () => h.pool.urls,
    refresh: () => { channel = h.client.channel(h.id)!; }, deliver: async chat => { h.effects.push(chat.rumorId); },
  });
  expect(channel.streams.length).toBe(2); expect(h.effects).toHaveLength(1);
  expect(h.snapshot().repairFloor).toBeUndefined(); expect(h.snapshot().certifiedUntil).toBeLessThan(Math.floor(Date.now() / 1000));
});

it('missing exact control IDs retain recovery even when every payload source could answer', async () => {
  const h = await fixture(), fetch = h.pool.fetchRelay!; let channel = h.client.channel(h.id)!;
  h.pool.fetchRelay = async (url, ids, filter, opts) => filter.authors!.includes(channel.current.group.pk) ? fetch(url, ids, filter, opts) : [];
  const repair = () => h.client.repairDelivery(h.lane, { store: h.store, channel: () => channel, relays: () => h.pool.urls,
    refresh: () => { channel = h.client.channel(h.id)!; }, deliver: async chat => { h.effects.push(chat.rumorId); },
  });
  await expect(repair()).rejects.toThrow('Control inventory contains unavailable IDs');
  expect(h.snapshot().repairFloor).toBe(0); expect(h.snapshot().certifiedUntil).toBeUndefined(); expect(h.effects).toEqual([]);
  h.pool.fetchRelay = fetch; await repair(); expect(h.effects).toHaveLength(1); expect(h.snapshot().repairFloor).toBeUndefined();
});

it('source inventory bounds stop an oversized control second without clearing recovery', async () => {
  const h = await fixture(), enumerate = h.pool.enumerateRelay!; let channel = h.client.channel(h.id)!, requests = 0;
  const { ReplayWindowLimitError } = await import('./reconciliation');
  const at = Math.floor(Date.now() / 1000) - 120;
  h.pool.enumerateRelay = async (_url, filter) => {
    requests++;
    if (filter.since! <= at && (filter.until === undefined || filter.until >= at)) throw new ReplayWindowLimitError('synthetic source inventory bound');
    return [];
  };
  const repair = () => h.client.repairDelivery(h.lane, { store: h.store, channel: () => channel, relays: () => h.pool.urls,
    refresh: () => { channel = h.client.channel(h.id)!; }, deliver: async chat => { h.effects.push(chat.rumorId); },
  });
  await expect(repair()).rejects.toThrow('synthetic source inventory bound');
  expect(requests).toBeLessThan(100); expect(h.effects).toEqual([]); expect(h.snapshot().repairFloor).toBe(0); expect(h.snapshot().certifiedUntil).toBeUndefined();
  h.pool.enumerateRelay = enumerate; await repair(); expect(h.effects).toHaveLength(1);
});

it('standing control updates the shared fold even without an onFold observer', async () => {
  const h = await fixture(), unsubscribe = h.client.subscribeControl();
  try {
    expect(h.client.channels().length).toBe(2); h.lateControl();
    const deadline = Date.now() + 1000;
    while (h.client.channels().length < 3 && Date.now() < deadline) await Bun.sleep(10);
    expect(h.client.channels().length).toBe(3);
  } finally { unsubscribe(); }
});

for (const stage of ['initial', 'after learned keys'] as const) {
  it(`public runtime ${stage} startup classifies the signed public channel only after complete discovery`, async () => {
    const h = await fixture();
    // This is the exact held-key fallback that PUBLIC startup must not
    // classify from a successful capped bootstrap REQ.
    expect(h.client.channel(h.id)!.isPrivate).toBe(true);
    if (stage === 'after learned keys') {
      const held = h.client.community.privateChannels.splice(0);
      const beforeIntake = await ConcordClient.discover(h.client.community, h.pool, localIdentity(generateSecretKey()));
      expect(beforeIntake.channel(h.id)!.streams.length).toBe(1);
      h.client.community.privateChannels.push(...held);
    }
    const ready = await ConcordClient.discover(h.client.community, h.pool, localIdentity(generateSecretKey()));
    const target = ready.channel(h.id)!;
    expect(target.isPrivate).toBe(false); expect(target.streams.length).toBe(2);
    const lane = new LinkDelivery({ onError: () => {} }); let channel = target;
    await ready.repairDelivery(lane, { store: h.store, channel: () => channel, relays: () => h.pool.urls,
      refresh: () => { channel = ready.channel(h.id)!; }, deliver: async chat => { h.effects.push(chat.rumorId); },
    });
    expect(h.effects).toHaveLength(1); expect(h.snapshot().repairFloor).toBeUndefined();
  });
}
