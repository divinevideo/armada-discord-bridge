import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { migrate } from './migrate';
import { PostgresMappingStore, provisionStandalone, standaloneDeliveryOwner } from './store';
import { BridgeLeases, bridgeResource } from './leases';
import type { ChannelLink } from '../router';

const url = process.env.DATABASE_URL;
const sql = postgres(url ?? 'postgres://unused:unused@127.0.0.1:1/unused', { max: 4, connect_timeout: 2, onnotice() {} });
const reachable = url ? await sql`SELECT 1`.then(() => true, error => { if (['ECONNREFUSED','ETIMEDOUT','CONNECT_TIMEOUT','ENOTFOUND'].includes(error.code)) return false; throw error; }) : false;
const tenant = `standalone-provision-${crypto.randomUUID()}`;
const link: ChannelLink = { communityId: 'a'.repeat(64), concordChannelIdHex: 'b'.repeat(64), discordGuildId: tenant, discordChannelId: tenant, enabled: true };
const community = { idHex: link.communityId, relays: [], name: 'synthetic' };
const store = new PostgresMappingStore(sql, tenant);
beforeAll(async () => { if (reachable) await migrate(url!); });
afterAll(async () => { if (reachable) {
  await sql`DELETE FROM channel_delivery_lifecycles WHERE tenant_id=${tenant}`;
  await sql`DELETE FROM channel_links WHERE tenant_id=${tenant}`;
  await sql`DELETE FROM communities WHERE tenant_id=${tenant}`;
  await sql`DELETE FROM bridge_leases WHERE resource=${bridgeResource(link.discordGuildId,link.discordChannelId)}`;
} await sql.end(); });

test.skipIf(!reachable)('first standalone provisioning is atomic and later boot cannot revive stopped state', async () => {
  expect(await provisionStandalone(sql, link, community, ['stream'], 1000, tenant)).toBe(true);
  const initial = await store.inspectDelivery(link);
  expect(initial?.activationFloor).toBe(1000);
  expect(await provisionStandalone(sql, link, community, ['stream'], 2000, tenant)).toBe(false);
  expect((await store.inspectDelivery(link))?.epoch).toBe(initial?.epoch);
  await store.terminateDelivery(link, standaloneDeliveryOwner(link), initial!.epoch);
  expect(await provisionStandalone(sql, link, community, ['stream'], 3000, tenant)).toBe(false);
  const lease = (await new BridgeLeases(sql).acquire(bridgeResource(link.discordGuildId,link.discordChannelId)))!;
  try { await expect(store.openDelivery(link, standaloneDeliveryOwner(link), lease)).rejects.toThrow('lifecycle'); }
  finally { await lease.release(); }
  await sql`UPDATE channel_links SET enabled=false WHERE tenant_id=${tenant}`;
  await expect(provisionStandalone(sql, link, community, ['stream'], 4000, tenant)).rejects.toThrow('disabled');
  expect((await sql`SELECT enabled FROM channel_links WHERE tenant_id=${tenant}`)[0].enabled).toBe(false);
});

test.skipIf(!reachable)('failed first activation rolls its link insertion back', async () => {
  const other = { ...link, discordChannelId: `${tenant}-other` };
  await store.activateDelivery(other, 'different-owner', [], 1000);
  await expect(provisionStandalone(sql, other, community, [], 2000, tenant)).rejects.toThrow('lifecycle');
  expect(await sql`SELECT 1 FROM channel_links WHERE tenant_id=${tenant} AND discord_channel_id=${other.discordChannelId}`).toHaveLength(0);
});
