/**
 * Postgres-backed mapping store (single-tenant rows use tenant_id 'default';
 * the portal control plane sets real tenant ids later).
 */

import type postgres from "postgres";

import { deletionLinkKey, MAX_PENDING_DELETES_PER_LINK, MAX_PENDING_DELETES_PER_ACTOR } from "../router";
import type { PendingConcordDelete, ChannelLink, MappingStore, MessageMappingRow, ReactionMappingRow } from "../router";

export class PostgresMappingStore implements MappingStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly tenantId = "default",
  ) {}

  async saveDeletes(link: ChannelLink, rows: PendingConcordDelete[]): Promise<void> {
    if (!rows.length) return;
    await this.sql.begin(async tx => {
      // Serialize capacity decisions for this link across workers. Count and
      // insertion must share a transaction or two writers can both pass the cap.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.tenantId + deletionLinkKey(link)}, 19306))`;
      const held = await tx`SELECT delete_rumor_id, target_rumor_id, author FROM pending_concord_deletes
        WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
          AND concord_channel_id = ${link.concordChannelIdHex} AND discord_guild_id = ${link.discordGuildId}
          AND discord_channel_id = ${link.discordChannelId}`;
      const existing = new Set(held.map(row => `${row.delete_rumor_id}:${row.target_rumor_id}`));
      const fresh = [...new Map(rows.map(row => [`${row.deleteRumorId}:${row.targetRumorId}`, row])).values()]
        .filter(row => !existing.has(`${row.deleteRumorId}:${row.targetRumorId}`));
      if (held.length + fresh.length > MAX_PENDING_DELETES_PER_LINK || fresh.some(row =>
        held.filter(other => other.author === row.author).length + fresh.filter(other => other.author === row.author).length > MAX_PENDING_DELETES_PER_ACTOR)) {
        throw new Error("Pending Concord deletion capacity exceeded");
      }
      for (const row of fresh) await tx`INSERT INTO pending_concord_deletes
        (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id,
         delete_rumor_id, target_rumor_id, author, citation, created_at_ms)
        VALUES (${this.tenantId}, ${link.communityId}, ${link.concordChannelIdHex}, ${link.discordGuildId}, ${link.discordChannelId},
          ${row.deleteRumorId}, ${row.targetRumorId}, ${row.author}, ${row.citation ? tx.json(row.citation) : null}, ${row.createdAtMs})
        ON CONFLICT DO NOTHING`;
    });
  }

  async pendingDeletes(link: ChannelLink, target?: string): Promise<PendingConcordDelete[]> {
    const rows = await this.sql`SELECT delete_rumor_id, target_rumor_id, author, citation, created_at_ms
      FROM pending_concord_deletes WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
        AND concord_channel_id = ${link.concordChannelIdHex} AND discord_guild_id = ${link.discordGuildId}
        AND discord_channel_id = ${link.discordChannelId}
        ${target ? this.sql`AND target_rumor_id = ${target}` : this.sql``}
      ORDER BY created_at_ms, delete_rumor_id, target_rumor_id LIMIT ${MAX_PENDING_DELETES_PER_LINK}`;
    return rows.map(row => ({ deleteRumorId: row.delete_rumor_id as string, targetRumorId: row.target_rumor_id as string,
      author: row.author as string, createdAtMs: Number(row.created_at_ms), ...(row.citation ? { citation: row.citation as string[] } : {}) }));
  }

  async completeDelete(link: ChannelLink, deletion: string, target: string): Promise<void> {
    await this.sql`DELETE FROM pending_concord_deletes WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
      AND concord_channel_id = ${link.concordChannelIdHex} AND discord_guild_id = ${link.discordGuildId}
      AND discord_channel_id = ${link.discordChannelId} AND delete_rumor_id = ${deletion} AND target_rumor_id = ${target}`;
  }

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

  async insertReaction(row: ReactionMappingRow): Promise<void> {
    await this.sql`
      INSERT INTO reaction_mappings (tenant_id, rumor_id, discord_message_id, emoji, origin, author_ref)
      VALUES (${this.tenantId}, ${row.rumorId}, ${row.discordMessageId}, ${row.emoji}, ${row.origin}, ${row.authorRef})
      ON CONFLICT DO NOTHING`;
  }

  async reactionByDiscord(messageId: string, userId: string, emoji: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`
      SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${messageId}
        AND author_ref = ${userId} AND emoji = ${emoji}
      LIMIT 1`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async reactionByRumorId(rumorId: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`
      SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND rumor_id = ${rumorId}
      LIMIT 1`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async retiredReaction(link: ChannelLink, rumorId: string): Promise<ReactionMappingRow | undefined> {
    const rows = await this.sql`SELECT rumor_id, discord_message_id, emoji, origin, author_ref
      FROM retired_concord_reactions WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
      AND concord_channel_id = ${link.concordChannelIdHex} AND discord_guild_id = ${link.discordGuildId}
      AND discord_channel_id = ${link.discordChannelId} AND rumor_id = ${rumorId}`;
    return rows[0] ? this.toReactionRow(rows[0]) : undefined;
  }

  async retireReaction(link: ChannelLink, row: ReactionMappingRow): Promise<void> {
    // A later distinct deletion still needs target evidence. Retire atomically
    // with active removal, rather than leaving a crash gap or deduping re-adds.
    await this.sql.begin(async tx => {
      await tx`INSERT INTO retired_concord_reactions
        (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id,
         rumor_id, discord_message_id, emoji, origin, author_ref)
        VALUES (${this.tenantId}, ${link.communityId}, ${link.concordChannelIdHex}, ${link.discordGuildId}, ${link.discordChannelId},
          ${row.rumorId}, ${row.discordMessageId}, ${row.emoji}, ${row.origin}, ${row.authorRef}) ON CONFLICT DO NOTHING`;
      await tx`DELETE FROM reaction_mappings WHERE tenant_id = ${this.tenantId} AND rumor_id = ${row.rumorId}`;
    });
  }

  async deleteReaction(rumorId: string): Promise<void> {
    await this.sql`
      DELETE FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND rumor_id = ${rumorId}`;
  }

  async countConcordReactions(messageId: string, emoji: string): Promise<number> {
    const [row] = await this.sql`
      SELECT count(*)::int AS n FROM reaction_mappings
      WHERE tenant_id = ${this.tenantId} AND discord_message_id = ${messageId}
        AND emoji = ${emoji} AND origin = 'concord'`;
    return (row?.n as number) ?? 0;
  }

  /**
   * Newest processed wrap timestamp across a channel's stream addresses, or
   * undefined when this channel has never been tailed (fresh bridges do NOT
   * backfill: restored delivery must not replay history into Discord).
   * The pool merges relays, so cursors live under one sentinel relay_url.
   */
  async cursorGet(communityId: string, streamPks: string[]): Promise<number | undefined> {
    if (streamPks.length === 0) return undefined;
    const [row] = await this.sql`
      SELECT max(last_seen_at)::bigint AS at FROM cursors
      WHERE tenant_id = ${this.tenantId} AND community_id = ${communityId}
        AND stream_pk IN ${this.sql(streamPks)} AND relay_url = 'pool'`;
    return row?.at == null ? undefined : Number(row.at);
  }

  /** Full-link checkpoint: one bridge must never acknowledge another link's gap. */
  async channelCursorStart(link: ChannelLink, streamPks: string[]): Promise<number> {
    const legacy = streamPks.length ? await this.sql`SELECT min(last_seen_at)::bigint AS at FROM cursors
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId}
        AND stream_pk IN ${this.sql(streamPks)} AND relay_url = 'pool'` : [];
    const floor = legacy[0]?.at == null ? Math.floor(Date.now() / 1000) : Number(legacy[0].at);
    await this.sql`INSERT INTO channel_delivery_checkpoints
      (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id, last_seen_at)
      VALUES (${this.tenantId}, ${link.communityId}, ${link.concordChannelIdHex}, ${link.discordGuildId}, ${link.discordChannelId}, ${floor})
      ON CONFLICT DO NOTHING`;
    const [row] = await this.sql`SELECT last_seen_at FROM channel_delivery_checkpoints
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId} AND concord_channel_id = ${link.concordChannelIdHex}
      AND discord_guild_id = ${link.discordGuildId} AND discord_channel_id = ${link.discordChannelId}`;
    return Number(row.last_seen_at);
  }
  async channelCursorSet(link: ChannelLink, at: number): Promise<void> {
    const rows = await this.sql`UPDATE channel_delivery_checkpoints SET last_seen_at = GREATEST(last_seen_at, ${at})
      WHERE tenant_id = ${this.tenantId} AND community_id = ${link.communityId} AND concord_channel_id = ${link.concordChannelIdHex}
      AND discord_guild_id = ${link.discordGuildId} AND discord_channel_id = ${link.discordChannelId} RETURNING last_seen_at`;
    if (!rows.length) throw new Error("Channel delivery checkpoint must be established before admission");
  }

  /** Advance (never rewind) the high-water mark for one stream address. */
  async cursorSet(communityId: string, streamPk: string, lastSeenAt: number): Promise<void> {
    await this.sql`
      INSERT INTO cursors (tenant_id, community_id, stream_pk, relay_url, last_seen_at)
      VALUES (${this.tenantId}, ${communityId}, ${streamPk}, 'pool', ${lastSeenAt})
      ON CONFLICT (tenant_id, community_id, stream_pk, relay_url)
      DO UPDATE SET last_seen_at = GREATEST(cursors.last_seen_at, EXCLUDED.last_seen_at)`;
  }

  private toReactionRow(r: Record<string, unknown>): ReactionMappingRow {
    return {
      rumorId: r.rumor_id as string,
      discordMessageId: r.discord_message_id as string,
      emoji: r.emoji as string,
      origin: r.origin as "discord" | "concord",
      authorRef: r.author_ref as string,
    };
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
    INSERT INTO communities (tenant_id, community_id, relays, name)
    VALUES (${tenantId}, ${community.idHex}, ${community.relays}, ${community.name ?? null})
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
