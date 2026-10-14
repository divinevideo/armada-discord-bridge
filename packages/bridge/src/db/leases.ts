import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export class BridgeLeaseUnavailableError extends Error {}

export interface BridgeLease {
  readonly token: bigint;
  assertCurrent(): Promise<void>;
  renew(): Promise<void>;
  release(): Promise<void>;
}

/** Portal and standalone workers fence the same external resource. */
export function bridgeResource(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

export class BridgeLeases {
  constructor(private readonly sql: postgres.Sql) {}

  async acquire(resource: string): Promise<BridgeLease | undefined> {
    const holder = randomUUID();
    const [row] = await this.sql`
      INSERT INTO bridge_leases (resource, holder, token, expires_at)
      VALUES (${resource}, ${holder}, 1, clock_timestamp() + interval '90 seconds')
      ON CONFLICT (resource) DO UPDATE SET holder = EXCLUDED.holder,
        token = bridge_leases.token + 1, expires_at = EXCLUDED.expires_at
      WHERE bridge_leases.expires_at <= clock_timestamp()
      RETURNING token::text`;
    if (!row) return undefined;
    const token = BigInt(row.token);
    let live = true;
    const check = () => { if (!live) throw new BridgeLeaseUnavailableError("Bridge lease is no longer current"); };
    const renew = async () => {
      check();
      try {
        const renewed = await this.sql`
          UPDATE bridge_leases SET expires_at = clock_timestamp() + interval '90 seconds'
          WHERE resource = ${resource} AND holder = ${holder} AND token = ${token.toString()}
            AND expires_at > clock_timestamp() RETURNING resource`;
        if (!renewed.length) throw new BridgeLeaseUnavailableError("Bridge lease expired or was superseded");
      } catch (error) {
        live = false;
        clearInterval(timer);
        throw error;
      }
    };
    const timer = setInterval(() => { void renew().catch(() => {}); }, 30_000);
    timer.unref();
    return {
      token,
      renew,
      assertCurrent: async () => {
        check();
        const current = await this.sql`
          SELECT 1 FROM bridge_leases WHERE resource = ${resource}
          AND holder = ${holder} AND token = ${token.toString()} AND expires_at > clock_timestamp()`;
        check();
        if (!current.length) {
          live = false;
          clearInterval(timer);
          throw new BridgeLeaseUnavailableError("Bridge lease expired or was superseded");
        }
      },
      release: async () => {
        live = false;
        clearInterval(timer);
        await this.sql`UPDATE bridge_leases SET expires_at = clock_timestamp()
          WHERE resource = ${resource} AND holder = ${holder} AND token = ${token.toString()}`;
      },
    };
  }

  async withBridgeLease<T>(resource: string, work: (lease: BridgeLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(resource);
    if (!lease) throw new BridgeLeaseUnavailableError("Bridge lease is owned by another worker");
    try { return await work(lease); } finally { await lease.release(); }
  }
}
