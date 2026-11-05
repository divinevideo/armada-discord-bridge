import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import type { DeliveredChat, ReplayOptions } from '../packages/bridge/src/concord/replay';
import type { DeliverySnapshot } from '../packages/bridge/src/db/deliveryState';
import type { ChannelLink } from '../packages/bridge/src/router';
import { PostgresMappingStore } from '../packages/bridge/src/db/store';
import { migrate } from '../packages/bridge/src/db/migrate';
import { probeFloor, readProbeState, scanCandidates, secondsIso } from './probe-backlog';

const channel = { streams: [{ group: { pk: 'a'.repeat(64) } }] } as ChannelV2;
const context = { signal: new AbortController().signal };
const chats = (...kinds: number[]) => kinds.map(kind => ({ kind }) as DeliveredChat);
const snapshot: DeliverySnapshot = { ownerId: 'synthetic', epoch: crypto.randomUUID(), active: true, suspended: false,
  version: 2, activationFloor: 1000, recoveryFloor: 900, deletionFloor: 1000, workerUncertain: false, sessionGeneration: 1,
  repairFloor: 501, certifiedUntil: 500, coverage: { ['a'.repeat(64)]: 500 }, ordinaryCoverage: {}, legacyBoundaries: {} };

test('importing the probe does not execute its CLI or require runtime configuration', async () => {
  const child = Bun.spawn([process.execPath, '-e', `await import(${JSON.stringify(import.meta.dir + '/probe-backlog.ts')}); console.log('imported');`],
    { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe('imported\n');
  expect(await new Response(child.stderr).text()).toBe('');
});

test('seconds display correctly and uncertain replacement enumeration does not inherit the applicability floor', () => {
  expect(secondsIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
  expect(secondsIso(undefined)).toBeUndefined();
  expect(probeFloor(snapshot, ['a'.repeat(64)])).toBe(501);
  expect(probeFloor({ ...snapshot, workerUncertain: true }, ['a'.repeat(64)])).toBe(0);
  expect(probeFloor({ ...snapshot, repairFloor: undefined }, ['a'.repeat(64)])).toBe(440);
  expect(probeFloor({ ...snapshot, repairFloor: undefined, recoveryFloor: 100 }, ['new'])).toBe(40);
  expect(snapshot.deletionFloor).toBe(1000);
});

test('streamed kinds include deletes/reactions/other without predicting Discord effects', async () => {
  const result = await scanCandidates(channel, 10, async (_c, since, limit, options) => {
    expect(since).toBe(10); expect(limit).toBe(100);
    for (let i = 0; i < 300; i++) await options.onBatch!({ chats: chats(9, 5, 7, 23311, 999999) }, context);
    await options.onWindowComplete!({ since, until: 20, runUntil: 20 }, context);
    return { chats: [], certifiedUntil: 20 };
  });
  expect(result.decodedCandidates).toBe(1500);
  expect(result.decodedCandidatesByKind).toEqual({ message: 300, deletion: 300, reaction: 300, typing: 300, other: 300 });
  expect(result.scanComplete).toBe(true); expect(result.observedCertifiedUntil).toBe(20);
  expect(Object.keys(result).some(key => /posts|discord|chats/i.test(key))).toBe(false);
});

test('candidate budget retains only an earlier certified prefix and bounds later callback work', async () => {
  let after = false;
  const result = await scanCandidates(channel, 10, async (_c, since, _limit, options) => {
    await options.onBatch!({ chats: chats(5) }, context);
    await options.onWindowComplete!({ since, until: 20, runUntil: 40 }, context);
    await options.onBatch!({ chats: chats(9, 9, 9, 9) }, context);
    after = true;
    return { chats: [], certifiedUntil: 40 };
  }, { maxCandidates: 3 });
  expect(after).toBe(false); expect(result.decodedCandidates).toBe(3);
  expect(result.scanComplete).toBe(false); expect(result.observedCertifiedUntil).toBe(20);
  expect(result.incompleteReason).toBe('candidate_budget');
});

test('empty-window work budget and relay failure cannot certify later intervals or expose source errors', async () => {
  const result = await scanCandidates(channel, 10, async (_c, since, _limit, options) => {
    for (let until = 10; until < 100; until++) await options.onWindowComplete!({ since, until, runUntil: 100 }, context);
    return { chats: [] };
  }, { maxWindows: 2 });
  expect(result.completedWindows).toBe(2); expect(result.observedCertifiedUntil).toBe(11);
  expect(result.incompleteReason).toBe('window_budget'); expect(result.scanComplete).toBe(false);
  const opaque = 'f'.repeat(64);
  const failed = await scanCandidates(channel, 0, async (_c, _since, _limit, options) => {
    await options.onBatch!({ chats: chats(5) }, context);
    const error = new Error(`private payload ${opaque}`); error.name = opaque; throw error;
  });
  expect(failed.observedCertifiedUntil).toBeUndefined(); expect(failed.decodedCandidates).toBe(1);
  expect(failed.incompleteReason).toBe('replay_unavailable'); expect(JSON.stringify(failed)).not.toContain(opaque);
});

test('deadline aborts replay and rejects late callback observations', async () => {
  let captured: ReplayOptions | undefined;
  const result = await scanCandidates(channel, 0, async (_c, _since, _limit, options) => {
    captured = options;
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    return { chats: [] };
  }, { durationMs: 10 });
  expect(result.incompleteReason).toBe('deadline_or_abort'); expect(result.scanComplete).toBe(false);
  await expect(captured!.onBatch!({ chats: chats(9) }, context)).rejects.toThrow();
  await expect(captured!.onWindowComplete!({ since: 0, until: 100, runUntil: 100 }, context)).rejects.toThrow();
  expect(result.decodedCandidates).toBe(0); expect(result.observedCertifiedUntil).toBeUndefined();
});

const url = process.env.DATABASE_URL;
const sql = postgres(url ?? 'postgres://unused:unused@127.0.0.1:1/unused', { connect_timeout: 2, onnotice() {} });
const reachable = url ? await sql`SELECT 1`.then(() => true, error => {
  if (['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'ENOTFOUND'].includes(error.code)) return false;
  throw error;
}) : false;
const tenant = `probe-${crypto.randomUUID()}`;
const link: ChannelLink = { communityId: 'a'.repeat(64), concordChannelIdHex: 'b'.repeat(64), discordGuildId: tenant, discordChannelId: tenant, enabled: true };
beforeAll(async () => { if (reachable) await migrate(url!); });
afterAll(async () => {
  if (reachable) for (const table of ['channel_delivery_lifecycles', 'channel_delivery_upgrade_eligibility', 'channel_delivery_checkpoints'])
    await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
  await sql.end();
});
test.skipIf(!reachable)('actual PG inspection preserves missing/upgrade/lifecycle state under enforced read-only transaction', async () => {
  let readOnly: string | undefined;
  const observedSql = { begin: (mode: string, work: (tx: postgres.TransactionSql) => Promise<unknown>) => sql.begin(mode, async tx => {
    const [setting] = await tx`SHOW transaction_read_only`; readOnly = setting.transaction_read_only;
    return work(tx);
  }) } as unknown as postgres.Sql;
  expect(await readProbeState(observedSql, tenant, link, 'synthetic-owner')).toEqual({ snapshot: undefined, upgrade: 'none' });
  expect(readOnly).toBe('on');
  expect(await new PostgresMappingStore(sql, tenant).inspectDelivery(link)).toBeUndefined();
  await sql`INSERT INTO channel_delivery_upgrade_eligibility (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,owner_id)
    VALUES (${tenant},${link.communityId},${link.concordChannelIdHex},${link.discordGuildId},${link.discordChannelId},'synthetic-owner')`;
  expect((await readProbeState(observedSql, tenant, link, 'synthetic-owner')).upgrade).toBe('eligible');
  expect((await readProbeState(observedSql, tenant, { ...link, discordGuildId: 'other-synthetic-guild' }, 'synthetic-owner')).upgrade).toBe('none');
  expect(await new PostgresMappingStore(sql, tenant).inspectDelivery(link)).toBeUndefined();
  const store = new PostgresMappingStore(sql, tenant);
  await store.activateDelivery(link, 'synthetic-owner', [], 1_700_000_000);
  const before = await store.inspectDelivery(link);
  const observed = await readProbeState(observedSql, tenant, link, 'synthetic-owner');
  expect(observed.snapshot).toEqual(before); expect(observed.upgrade).toBe('consumed');
  expect(await store.inspectDelivery(link)).toEqual(before);
  expect((await sql`SELECT count(*)::int AS n FROM channel_delivery_checkpoints WHERE tenant_id=${tenant}`)[0].n).toBe(0);
});
