import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { BENCHMARK_IDENTITY_SQL } from './capacity-kubernetes';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice() {} });
afterAll(() => sql.end());
test('PostgreSQL identity SQL returns the bare server host rather than inet display masks', async () => {
  const [identity] = await sql.unsafe(BENCHMARK_IDENTITY_SQL);
  const [address] = await sql`SELECT pg_catalog.host(pg_catalog.inet_server_addr()) AS host`;
  expect(address.host).toBeTypeOf('string');
  expect(identity.serverAddress).toBe(address.host);
  expect(identity.serverAddress).not.toContain('/');
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeCapacityMeasurement } from './strfry-capacity';

test('artifact failure still closes real SQL sessions and the owned transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-artifact-failure-'));
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice() {} });
  const [session] = await client`SELECT pg_backend_pid() AS pid`;
  const calls: string[] = [];
  try {
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'synthetic');
    await expect(finalizeCapacityMeasurement(
      () => writeFile(join(blocker, 'measurement-report.json'), 'synthetic'),
      [async () => { await client.end(); calls.push('sql'); }, () => { calls.push('locker'); }, () => { calls.push('transport'); }, () => { calls.push('temp'); }],
    )).rejects.toThrow();
    expect(calls).toEqual(['sql', 'locker', 'transport', 'temp']);
    expect((await sql`SELECT 1 FROM pg_stat_activity WHERE pid=${session.pid}`).length).toBe(0);
  } finally { await client.end(); await rm(directory, { recursive: true, force: true }); }
});

test('SQL shutdown failure cannot strand remaining cleanup or its idle connection', async () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice() {} });
  const [session] = await client`SELECT pg_backend_pid() AS pid`;
  const calls: string[] = [];
  try {
    await expect(finalizeCapacityMeasurement(async () => {}, [
      () => { calls.push('sql'); throw new Error('synthetic shutdown failure'); },
      () => { calls.push('locker'); },
      async () => { calls.push('transport'); await client.end(); },
      () => { calls.push('temp'); },
    ])).rejects.toThrow('synthetic shutdown failure');
    expect(calls).toEqual(['sql', 'locker', 'transport', 'temp']);
    expect((await sql`SELECT 1 FROM pg_stat_activity WHERE pid=${session.pid}`).length).toBe(0);
  } finally { await client.end(); }
});
