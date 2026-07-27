/**
 * Postgres-backed mapping store (single-tenant rows use tenant_id 'default';
 * the portal control plane sets real tenant ids later).
 */

import type postgres from "postgres";

import type { ChannelLink, MappingStore, MessageMappingRow } from "../router";

export class PostgresMappingStore implements MappingStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly tenantId = "default",
  ) {}

  async insert(row: MessageMappingRow): Promise<void> {
    await this.sql`
      INSERT INTO messages (
        tenant_id, discord_message_id, discord_channel_id,
        concord_rumor_id, concord_channel_id, community_id,
        origin, author_ref, part_index
      ) VALUES (
        ${this.tenantId}, ${row.discordMessageId}, ${row.discordChannelId},
        ${row.concordRumorId}, ${row.concordChannelId}, ${row.communityId},
        ${row.origin}, ${row.authorRef}, ${row.partIndex}
      )
      ON CONFLICT DO NOTHING`;
  }

  async byRumorId(rumorId: string): Promise<MessageMappingRow[]> {
    const rows = await this.sql`
      SELECT discord_message_id, discord_channel_id, concord_rumor_id,
             concord_channel_id, community_id, origin, author_ref, part_index
      FROM messages
      WHERE tenant_id = ${this.tenantId} AND concord_rumor_id = ${rumorId}`;
    return rows.map((r) => this.toRow(r));
  }

  async byDiscordId(discordMessageId: string): Promise<MessageMappingRow[]> {
    const rows = await this.sql`
      SELECT discord_message_id, discord_channel_id, concord_rumor_id,
             concord_channel_id, community_id, origin, author_ref, part_index
      FROM messages
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${discordMessageId}`;
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: Record<string, unknown>): MessageMappingRow {
    return {
      discordMessageId: r.discord_message_id as string,
      discordChannelId: r.discord_channel_id as string,
      concordRumorId: r.concord_rumor_id as string,
      concordChannelId: r.concord_channel_id as string,
      communityId: r.community_id as string,
      origin: r.origin as "discord" | "concord",
      authorRef: r.author_ref as string,
      partIndex: r.part_index as number,
    };
  }
}

/** Upsert the community + link rows for env-provisioned (MVP) bridges. */
export async function ensureLink(
  sql: postgres.Sql,
  link: ChannelLink,
  community: { idHex: string; relays: string[]; name?: string },
  tenantId = "default",
): Promise<void> {
  await sql`
    INSERT INTO communities (tenant_id, community_id, sealed_keys, relays, name)
    VALUES (${tenantId}, ${community.idHex}, ${Buffer.alloc(0)}, ${community.relays}, ${community.name ?? null})
    ON CONFLICT (tenant_id, community_id)
    DO UPDATE SET relays = EXCLUDED.relays, name = EXCLUDED.name`;
  await sql`
    INSERT INTO channel_links (
      tenant_id, discord_guild_id, discord_channel_id,
      community_id, concord_channel_id, enabled
    ) VALUES (
      ${tenantId}, ${link.discordGuildId}, ${link.discordChannelId},
      ${link.communityId}, ${link.concordChannelIdHex}, ${link.enabled}
    )
    ON CONFLICT (tenant_id, discord_channel_id, concord_channel_id)
    DO UPDATE SET enabled = EXCLUDED.enabled`;
}
