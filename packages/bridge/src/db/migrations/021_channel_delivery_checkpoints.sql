-- A stream rotation or a new worker must not erase a live delivery gap.
-- Keep link progress separate from legacy per-stream cursors: independent
-- Discord links may consume identical streams at different rates.
CREATE TABLE channel_delivery_checkpoints (
  tenant_id text NOT NULL,
  community_id text NOT NULL,
  concord_channel_id text NOT NULL,
  discord_guild_id text NOT NULL,
  discord_channel_id text NOT NULL,
  last_seen_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id)
);
