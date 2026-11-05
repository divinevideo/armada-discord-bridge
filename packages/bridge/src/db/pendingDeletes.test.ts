import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import { channelsView, controlGroups, grantLocator, bytesToHex, hex32, openChatBatch, openControlWraps, foldControlState } from '@armada-bridge/concord-core';
import { generateSecretKey } from 'nostr-tools/pure';
import fixture from '../../../../test-fixtures/concord/community-interop.json';
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
const pending = (id: string, author = 'actor'): PendingConcordDelete => ({ deleteRumorId: id, targetRumorId: id, author, createdAtMs: Date.now() });
beforeAll(() => migrate(url));
afterAll(async () => {
  await sql`DELETE FROM pending_concord_deletes WHERE tenant_id LIKE ${tenant + '%'}`;
  await sql`DELETE FROM messages WHERE tenant_id = ${tenant}`;
  await sql`DELETE FROM cursors WHERE tenant_id = ${tenant}`;
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
    await create().retryPendingDeletes(link);
    expect(deleted).toEqual(['synthetic-message']);
    expect(await store.pendingDeletes(link)).toEqual([]);
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
