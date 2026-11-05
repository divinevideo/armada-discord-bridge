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
    client: { assertDeliveryHealthy: () => {}, backfillChannel: async () => ({ chats, newestWrapAt: 100 }) },
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

  it('keeps a failed deletion nondurable and does not complete catch-up', async () => {
    const h = harness([deletion, message], new Error('deletion storage unavailable'));
    await expect(h.manager.backfillMissed(h.rb)).rejects.toThrow('deletion storage unavailable');
    expect(h.delivered()).toBe(1);
    expect(h.rb.concordCatchupReady).toBe(false);
    expect(h.checkpoints).toEqual([]);
  });
});
