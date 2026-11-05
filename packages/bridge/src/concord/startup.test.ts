import { describe, expect, it } from 'bun:test';
import { buildRumor, channelBindingTags, channelsView, controlGroups, foldControlState, openControlWraps, sealRumor, wrapSeal } from '@armada-bridge/concord-core';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { generateSecretKey } from 'nostr-tools/pure';
import { moderationFixture } from '../../../../scripts/fixtures/moderation-events';
import { BridgeRouter, MemoryMappingStore } from '../router';
import { PuppetCache } from '../puppets';
import { ConcordClient } from './client';
import { deliverConcordChat } from './delivery';
import { localIdentity } from './signer';
import { startConcordDelivery } from './startup';
import type { RelayLike } from './pool';

const matches = (filter: NostrFilter, event: NostrEvent) =>
  (!filter.kinds || filter.kinds.includes(event.kind)) &&
  (!filter.authors || filter.authors.includes(event.pubkey)) &&
  (filter.since === undefined || event.created_at >= filter.since) &&
  (filter.until === undefined || event.created_at <= filter.until);

class HistoryAndTail implements RelayLike {
  events: NostrEvent[] = [];
  subscriptions: Array<{ filters: NostrFilter[]; onEvent: (event: NostrEvent) => void }> = [];
  query = async (filters: NostrFilter[]) => [...new Map(filters.flatMap(filter => this.events
    .filter(event => matches(filter, event)).sort((a, b) => b.created_at - a.created_at)
    .slice(0, filter.limit ?? Infinity)).map(event => [event.id, event])).values()];
  queryStrict = this.query;
  readonly replayRelays = ['fake'];
  async enumerateRelay(_url: string, filter: NostrFilter) { return this.events.filter(event => matches(filter, event)).map(event => event.id); }
  async fetchRelay(_url: string, ids: string[]) { return this.events.filter(event => ids.includes(event.id)); }
  async publish(event: NostrEvent) {
    this.events.push(event);
    for (const sub of this.subscriptions) if (sub.filters.some(filter => matches(filter, event))) sub.onEvent(event);
  }
  subscribe(filters: NostrFilter[], handlers: { onEvent: (event: NostrEvent) => void }) {
    const sub = { filters, onEvent: handlers.onEvent }; this.subscriptions.push(sub);
    return () => { this.subscriptions = this.subscriptions.filter(other => other !== sub); };
  }
  async close() {}
}

describe('standalone catch-up handoff', () => {
  it('captures a signed self-delete during a slow initial mirror before acknowledging newer traffic', async () => {
    const f = await moderationFixture(); const pool = new HistoryAndTail();
    const client = new ConcordClient(f.community, pool, localIdentity(generateSecretKey()));
    client.folded = foldControlState(openControlWraps(f.policy.controlEvents, controlGroups(f.community)), f.community.id, f.owner.pk);
    const channel = channelsView(f.community, client.folded)[0];
    const publishMemberChat = async (content: string, kind = 9, tags: string[][] = []) => {
      const rumor = buildRumor({ pubkey: f.member.pk, kind, content, tags: [...channelBindingTags(channel.idHex, 0n), ...tags], ms: Date.now() });
      const wrap = wrapSeal(await sealRumor(rumor, 20013, channel.current.group, f.member.signer), channel.current.group);
      await pool.publish(wrap); return { rumor, wrap };
    };
    const link = { communityId: f.community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'g', discordChannelId: 'c', enabled: true };
    const store = new MemoryMappingStore(); const deleted: string[] = [];
    const originalNow = Date.now; const initialTime = Math.floor(originalNow() / 1000);
    let clock = initialTime - 100, sends = 0, floorPersisted = false, controlInstalled = false;
    let deletionAt = 0, unsubscribe = () => {};
    let finishCatchup!: () => void;
    const caughtUp = new Promise<void>(resolve => { finishCatchup = resolve; });
    try {
      Date.now = () => clock * 1000;
      const target = await publishMemberChat('backlog target');
      const router = new BridgeRouter(client, new PuppetCache('ab'.repeat(32)), store, {
        send: async () => {
          if (++sends === 1) {
            expect(floorPersisted).toBe(true);
            expect(controlInstalled).toBe(true);
            clock = initialTime + 1;
            const deletion = await publishMemberChat('', 5, [['e', target.rumor.id]]);
            deletionAt = deletion.wrap.created_at;
            clock = initialTime + 120; // A slow Discord send outlasts the live-tail overlap.
          }
          return `discord-${sends}`;
        },
        delete: async (_link, id, check) => { check?.(); deleted.push(id); },
        edit: async () => {}, react: async () => {}, unreact: async () => {}, sendTyping: async () => {},
      }, { resolve: async pk => ({ name: pk }) }, { applicationId: 'synthetic', webhookIds: new Set() }, { beforeSideEffect: async () => {} });
      const deliver = (chat: Parameters<BridgeRouter['onConcordChat']>[0]) => deliverConcordChat(router, chat, link, error => { throw error; });
      clock = initialTime;
      await startConcordDelivery({
        establishFloor: async () => { floorPersisted = true; },
        installLive: () => {
          expect(floorPersisted).toBe(true);
          unsubscribe = client.subscribeChannel(channel, deliver);
        },
        installControl: () => { controlInstalled = true; },
        catchUp: async () => {
          await client.backfillChannel(channel, target.wrap.created_at - 60, 500, { onBatch: async batch => {
            for (const chat of batch.chats) await deliver(chat);
          } });
          finishCatchup();
        },
      });
      await caughtUp;
      await publishMemberChat('newer live message');
      // The deletion shares the serial router lane with subsequent traffic.
      for (let i = 0; i < 100 && sends < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(controlInstalled).toBe(true);
      expect(deletionAt).toBe(initialTime + 1);
      expect(sends).toBe(2);
      expect(deleted).toEqual(['discord-1']);
      expect(await store.pendingDeletes(link)).toEqual([]);
    } finally { unsubscribe(); Date.now = originalNow; }
  });
});

it('returns startup control while slow replay remains pending', async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const order: string[] = [];
  const result = startConcordDelivery({
    establishFloor: async () => { order.push('floor'); },
    installLive: () => { order.push('live'); },
    installControl: () => { order.push('control'); },
    catchUp: async () => { order.push('replay'); entered(); await blocked; },
  });
  await started;
  const completed = await Promise.race([result.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10))]);
  release();
  expect(completed).toBe(true);
  expect(order).toEqual(['floor', 'live', 'control', 'replay']);
});
