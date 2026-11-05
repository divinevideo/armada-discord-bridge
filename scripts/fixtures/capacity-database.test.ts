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
