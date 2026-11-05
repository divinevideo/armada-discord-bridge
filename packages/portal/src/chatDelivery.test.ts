import { describe, expect, it } from 'bun:test';
import { channelsView, openChatBatch } from '@armada-bridge/concord-core';
import { bootstrapFixture } from '../../../scripts/fixtures/community-bootstrap';
import fixture from '../../../test-fixtures/concord/community-interop.json';
import { BridgeManager } from './manager';

const { community, folded } = bootstrapFixture(fixture);
const channel = channelsView(community, folded)[0];
const message = (await openChatBatch([fixture.chatEvent], channel))[0];
const deletion = (await openChatBatch([fixture.moderatorDeleteEvent], channel))[0];

function harness(chats: typeof message[], failure: unknown) {
  let alerts = 0, delivered = 0;
  const checkpoints: number[] = [];
  const manager = Object.create(BridgeManager.prototype);
  manager.store = { channelCursorStart: async () => 0, channelCursorSet: async (_link: unknown, at: number) => { checkpoints.push(at); } };
  manager.alertMissingWebhookPermission = async () => { alerts++; };
  const rb = {
    id: 'synthetic-chat-delivery', channel, concordCatchupReady: false,
    link: { communityId: community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'g', discordChannelId: 'c', enabled: true },
    client: { assertDeliveryHealthy: () => {}, backfillChannel: async (_channel: unknown, _since: number, _limit: number, opts: { onBatch: (batch: unknown) => Promise<void> }) => { await opts.onBatch({ chats, newestWrapAt: 100 }); return { chats: [], newestWrapAt: 100 }; } },
    router: { assertDeletionDeliveryDurable: () => {}, onConcordChat: async () => { if (++delivered === 1) throw failure; return ['mirror']; } },
  };
  return { manager, rb, checkpoints, alerts: () => alerts, delivered: () => delivered };
}

describe('portal catch-up delivery failure boundaries', () => {
  it('contains missing-permission failures, alerts once, and continues catch-up', async () => {
    const h = harness([message, message], { code: 50013 });
    await h.manager.backfillMissed(h.rb);
    expect(h.alerts()).toBe(1);
    expect(h.delivered()).toBe(2);
    expect(h.rb.concordCatchupReady).toBe(true);
    expect(h.checkpoints).toEqual([100]);
  });

  it('commits only complete earlier batches when a later deletion fails', async () => {
    const h = harness([], new Error('unused'));
    h.rb.router.onConcordChat = async () => ['mirror'];
    h.rb.client.backfillChannel = async (_channel, _since, _limit, opts) => {
      await opts.onBatch({ chats: [message], newestWrapAt: 100 });
      h.rb.router.onConcordChat = async () => { throw new Error('later deletion storage failure'); };
      await opts.onBatch({ chats: [deletion], newestWrapAt: 200 });
      return { chats: [], newestWrapAt: 200 };
    };
    await expect(h.manager.backfillMissed(h.rb)).rejects.toThrow('later deletion storage failure');
    expect(h.checkpoints).toEqual([100]);
    expect(h.rb.concordCatchupReady).toBe(false);
  });

  it('coalesces catch-up retries and resumes after a relay failure', async () => {
    const h = harness([], new Error('unused'));
    let queries = 0, release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    h.rb.client.backfillChannel = async (_channel, _since, _limit, opts) => {
      if (++queries === 1) { await blocked; throw new Error('relay unavailable'); }
      await opts.onBatch({ chats: [], newestWrapAt: 100 });
      return { chats: [], newestWrapAt: 100 };
    };
    const first = h.manager.backfillMissed(h.rb);
    expect(h.manager.backfillMissed(h.rb)).toBe(first);
    release(); await expect(first).rejects.toThrow('relay unavailable');
    expect(h.checkpoints).toEqual([]);
    await h.manager.backfillMissed(h.rb);
    expect(queries).toBe(2);
    expect(h.checkpoints).toEqual([100]);
    expect(h.rb.concordCatchupReady).toBe(true);
  });

  it('keeps a failed deletion nondurable and does not complete catch-up', async () => {
    const h = harness([deletion, message], new Error('deletion storage unavailable'));
    await expect(h.manager.backfillMissed(h.rb)).rejects.toThrow('deletion storage unavailable');
    expect(h.delivered()).toBe(1);
    expect(h.rb.concordCatchupReady).toBe(false);
    expect(h.checkpoints).toEqual([]);
  });
});
