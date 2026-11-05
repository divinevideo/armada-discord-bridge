import { expect, it } from 'bun:test';
import { ChannelType } from 'discord.js';
import { channelsView, openChatBatch } from '@armada-bridge/concord-core';
import { generateSecretKey } from 'nostr-tools/pure';
import fixture from '../../../test-fixtures/concord/community-interop.json';
import { bootstrapFixture } from '../../../scripts/fixtures/community-bootstrap';
import { BridgeManager } from '../../portal/src/manager';
import { ConcordClient } from './concord/client';
import { localIdentity } from './concord/signer';
import { CONCORD_EFFECT_METHODS, guardEffects } from './effectGuard';
import { BridgeRouter, MemoryMappingStore } from './router';
import { PuppetCache } from './puppets';

function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const boot = bootstrapFixture(fixture), channel = channelsView(boot.community, boot.folded)[0];
const link = { communityId: boot.community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: '100000000000000001', discordChannelId: '100000000000000002', enabled: true };

for (const preparation of ['webhook', 'edit lookup', 'notice lookup', 'channel', 'message', 'webhook creation', 'username retry'] as const) {
  it(`retains the original worker through held Discord ${preparation} and allows the replacement's own call`, async () => {
    const entered = latch(), blocked = latch(); let oldCurrent = true, effects = 0, creations = 0, rejectUsername = preparation === 'username retry';
    const old = { assertMayForward: async () => { if (!oldCurrent) throw new Error('old session fenced'); } };
    const replacement = { assertMayForward: async () => {} }; let current = old;
    const manager: any = Object.create(BridgeManager.prototype); manager.activeRouterFor = () => current;
    const adapter: any = manager.buildAdapter('synthetic');
    const hold = async () => { entered.release(); await blocked.promise; };
    const webhook = { id: 'synthetic-webhook', name: 'armada-bridge', token: 'synthetic-token',
      send: async () => { if (rejectUsername) { rejectUsername = false; await hold(); throw { code: 50035, rawError: 'USERNAME_INVALID' }; } effects++; return { id: 'synthetic-message' }; },
      editMessage: async () => { effects++; },
    };
    adapter.client.channels.fetch = async () => {
      if (preparation === 'channel' || preparation === 'notice lookup') await hold();
      return { type: ChannelType.GuildText, fetchWebhooks: async () => { if (preparation === 'webhook creation') await hold(); return preparation === 'webhook creation' ? [] : [webhook]; },
        createWebhook: async () => { creations++; return webhook; }, send: async () => { effects++; }, sendTyping: async () => { effects++; },
        messages: { fetch: async () => { if (preparation === 'message') await hold(); return { react: async () => { effects++; } }; } } };
    };
    if (preparation === 'webhook' || preparation === 'edit lookup') adapter.webhookFor = async () => { await hold(); return webhook; };
    const sender = guardEffects(adapter, old.assertMayForward, new Set(['send', 'edit', 'notice', 'sendTyping', 'react']));
    const method = preparation === 'edit lookup' ? 'edit' : preparation === 'notice lookup' ? 'notice' : preparation === 'channel' ? 'sendTyping' : preparation === 'message' ? 'react' : 'send';
    const invoke = (port: any) => method === 'edit' ? port.edit(link, 'synthetic-message', 'synthetic') : method === 'notice' ? port.notice(link.discordChannelId, 'synthetic') : method === 'send' ? port.send(link, { username: 'Person', content: 'synthetic' }) : method === 'react' ? port.react(link, 'synthetic-message', '❤') : port.sendTyping(link);
    const warnings: unknown[][] = [], originalWarn = console.warn; console.warn = (...args) => { warnings.push(args); };
    try {
      const pending = invoke(sender); await entered.promise; oldCurrent = false; current = replacement; blocked.release();
      await expect(pending).rejects.toThrow('old session fenced');
      expect(effects).toBe(0); expect(creations).toBe(0);
      await invoke(guardEffects(adapter, replacement.assertMayForward, new Set(['send', 'edit', 'notice', 'sendTyping', 'react'])));
      expect(effects).toBe(1);
      expect(warnings.length).toBe(preparation === 'username retry' ? 1 : 0);
    } finally { blocked.release(); console.warn = originalWarn; await adapter.stop(); }
  });
}

it('a signed producer blocked in webhook lookup leaves neither an old Discord post nor a mapping', async () => {
  const entered = latch(), blocked = latch(); let allowed = true, effects = 0;
  const before = async () => { if (!allowed) throw new Error('old session fenced'); };
  const manager: any = Object.create(BridgeManager.prototype); manager.activeRouterFor = () => ({ assertMayForward: async () => {} });
  const adapter: any = manager.buildAdapter('synthetic');
  adapter.webhookFor = async () => { entered.release(); await blocked.promise; return { send: async () => { effects++; return { id: 'synthetic-message' }; } }; };
  const client = new ConcordClient(boot.community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey())); client.folded = boot.folded;
  const store = new MemoryMappingStore();
  const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, adapter, { resolve: async () => ({ name: 'Synthetic' }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: before });
  const chat = (await openChatBatch([fixture.chatEvent], channel))[0];
  try {
    const pending = router.onConcordChat(chat, link); await entered.promise; allowed = false; blocked.release();
    await expect(pending).rejects.toThrow('old session fenced'); expect(effects).toBe(0);
    expect(await store.byRumorId(chat.rumorId)).toEqual([]);
  } finally { blocked.release(); await adapter.stop(); }
});

for (const method of ['sendChat', 'sendTyping', 'publishProfile', 'publishDmRelays', 'publishJoin', 'publishManifest'] as const) {
  it(`fences ${method} at publication after its originating worker is replaced during signing`, async () => {
    const entered = latch(), blocked = latch(); let current = true, publications = 0;
    const author = localIdentity(generateSecretKey());
    const held = { ...author, signer: { ...author.signer, signEvent: async (event: any) => { entered.release(); await blocked.promise; return author.signer.signEvent(event); } } };
    const raw = new ConcordClient(boot.community, { query: async () => [], publish: async () => { publications++; }, subscribe: () => () => {}, close: async () => {} }, held); raw.folded = boot.folded;
    const client = guardEffects(raw, async () => { if (!current) throw new Error('old session fenced'); }, CONCORD_EFFECT_METHODS);
    const invoke = () => method === 'sendChat' ? client.sendChat(channel, { content: 'synthetic', author: held }) : method === 'sendTyping' ? client.sendTyping(channel, held) : method === 'publishProfile' ? client.publishProfile(held, { name: 'Synthetic' }) : method === 'publishDmRelays' ? client.publishDmRelays(held, ['wss://relay.example']) : method === 'publishJoin' ? client.publishJoin(Date.now(), held) : client.publishManifest([]);
    const pending = invoke(); await entered.promise; current = false; blocked.release();
    await expect(pending).rejects.toThrow('old session fenced'); expect(publications).toBe(0);
    current = true; await invoke(); expect(publications).toBe(1);
  });
}

import { REST } from 'discord.js';
import { fenceDiscordRest } from './discord/adapter';
import { withEffectGuard } from './effectGuard';

for (const mode of ['queued', 'queued current first', 'retry'] as const) {
  it(`the actual Discord REST ${mode} handler dispatches only the request's captured current-worker proof`, async () => {
    const entered = latch(), blocked = latch(); let oldCurrent = true, first = true;
    const dispatched: string[] = [];
    const rest = new REST({ offset: 0, retries: 1 }); rest.setToken('synthetic');
    fenceDiscordRest(rest, async (_url, init) => {
      expect(Object.getOwnPropertySymbols(init.headers)).toHaveLength(0);
      const content = JSON.parse(String(init.body)).content;
      if (first) { first = false; entered.release(); await blocked.promise;
        if (mode === 'retry') return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
      dispatched.push(content);
      return new Response('{"id":"synthetic"}', { headers: { 'content-type': 'application/json' } });
    });
    const route = `/channels/${link.discordChannelId}/messages` as const;
    const post = (content: string, before: () => Promise<void>) => withEffectGuard(before, () => rest.post(route, { body: { content } }));
    try {
      // The blocker already crossed the network boundary legitimately. The
      // old queued request / server-error retry has not yet been dispatched.
      const firstRequest = post(mode !== 'retry' ? 'blocker' : 'old', async () => { if (mode === 'retry' && !oldCurrent) throw new Error('old session fenced'); });
      await entered.promise;
      const earlyCurrent = mode === 'queued current first' ? post('current', async () => {}) : undefined;
      const oldRequest = mode !== 'retry' ? post('old', async () => { if (!oldCurrent) throw new Error('old session fenced'); }) : firstRequest;
      const currentRequest = earlyCurrent ?? post('current', async () => {});
      oldCurrent = false; blocked.release();
      await expect(oldRequest).rejects.toThrow('old session fenced');
      if (mode !== 'retry') await firstRequest;
      await currentRequest;
      expect(dispatched).toEqual(mode !== 'retry' ? ['blocker', 'current'] : ['current']);
    } finally { blocked.release(); rest.clearHashSweeper(); rest.clearHandlerSweeper(); }
  });
}

import { LinkDelivery } from './concord/linkDelivery';

it('stop owns a held signing callback until drain and its abort proof prevents final publication', async () => {
  const entered = latch(), blocked = latch(), author = localIdentity(generateSecretKey()); let publications = 0;
  const held = { ...author, signer: { ...author.signer, signEvent: async (event: any) => { entered.release(); await blocked.promise; return author.signer.signEvent(event); } } };
  const client = guardEffects(new ConcordClient(boot.community, { query: async () => [], publish: async () => { publications++; }, subscribe: () => () => {}, close: async () => {} }, author), async () => {}, CONCORD_EFFECT_METHODS);
  const lane = new LinkDelivery({ onError: () => {} });
  const pending = lane.run(async () => { await client.sendChat(channel, { content: 'synthetic', author: held }); });
  await entered.promise; lane.stop(); let drained = false; const draining = lane.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); blocked.release();
  await expect(pending).rejects.toThrow(); await draining; expect(drained).toBe(true); expect(publications).toBe(0);
});

it('a new replay gap aborts an old signed producer held in Discord preparation before actual dispatch', async () => {
  const entered = latch(), blocked = latch(); let effects = 0, checkpoints = 0;
  const manager: any = Object.create(BridgeManager.prototype); manager.activeRouterFor = () => ({ assertMayForward: async () => {} });
  const adapter: any = manager.buildAdapter('synthetic');
  adapter.webhookFor = async () => { entered.release(); await blocked.promise; return { send: async () => { effects++; return { id: 'synthetic-message' }; } }; };
  const client = new ConcordClient(boot.community, { query: async () => [], publish: async () => {}, subscribe: () => () => {}, close: async () => {} }, localIdentity(generateSecretKey())); client.folded = boot.folded;
  const store = new MemoryMappingStore();
  const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, adapter, { resolve: async () => ({ name: 'Synthetic' }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
  const chat = { ...(await openChatBatch([fixture.chatEvent], channel))[0], sourceWrapCreatedAt: 100 };
  const lane = new LinkDelivery({ onError: () => {} });
  const snapshot: any = { ownerId: 'synthetic', epoch: 'synthetic', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, version: 0, activationFloor: 0, recoveryFloor: 0, repairFloor: 0, coverage: {}, ordinaryCoverage: {}, legacyBoundaries: {} };
  const pending = lane.repair({ discover: async () => () => {}, channel: () => channel,
    store: { deliverySnapshot: async () => snapshot, certifyDelivery: async () => { checkpoints++; return true; } },
    replay: async (_channel, since, opts) => { await opts.onBatch!({ chats: [chat] }, { signal: opts.signal! }); await opts.onWindowComplete!({ since, until: 200, runUntil: 200 }, { signal: opts.signal! }); },
    deliver: async item => { await router.onConcordChat(item, link); },
  });
  try {
    await entered.promise; lane.markGap(50); blocked.release(); await expect(pending).rejects.toThrow();
    expect(effects).toBe(0); expect(checkpoints).toBe(0); expect(await store.byRumorId(chat.rumorId)).toEqual([]);
  } finally { blocked.release(); await lane.drain(); await adapter.stop(); }
});

it('manager command replies retain their worker in the owned lane through final REST dispatch', async () => {
  const entered = latch(), blocked = latch(); let effects = 0, allowed = true;
  const rest = new REST(); rest.setToken('synthetic');
  fenceDiscordRest(rest, async () => { effects++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); });
  const manager: any = Object.create(BridgeManager.prototype);
  const old = { delivery: new LinkDelivery({ onError: () => {} }), assertMayForward: async () => { if (!allowed) throw new Error('old session fenced'); } };
  let current = old; manager.activeRouterFor = () => current;
  const message = { channelId: link.discordChannelId, content: '/help', author: { bot: false },
    reply: async () => { entered.release(); await blocked.promise; return rest.post(`/channels/${link.discordChannelId}/messages`, { body: { content: 'synthetic command reply' } }); },
  };
  const errors: unknown[][] = [], original = console.error; console.error = (...args) => { errors.push(args); };
  try {
    expect(manager.handleBotCommand(message)).toBe(true); await entered.promise; allowed = false; old.delivery.stop(); blocked.release(); await old.delivery.drain();
    expect(effects).toBe(0); expect(errors).toHaveLength(1); expect(String(errors[0][0])).toContain('reply failed');
    current = { delivery: new LinkDelivery({ onError: () => {} }), assertMayForward: async () => {} };
    expect(manager.handleBotCommand(message)).toBe(true); await current.delivery.drain(); expect(effects).toBe(1);
  } finally { console.error = original; blocked.release(); rest.clearHashSweeper(); rest.clearHandlerSweeper(); }
});
