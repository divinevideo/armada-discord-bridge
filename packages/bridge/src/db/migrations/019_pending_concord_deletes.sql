-- A held citation can become resolvable after the relay cursor passes its
-- deletion. Keep the verified action until current authority permits it;
-- cursors and process memory are not a durable moderation retry queue.
CREATE TABLE pending_concord_deletes (
  tenant_id text NOT NULL,
  community_id text NOT NULL,
  concord_channel_id text NOT NULL,
  discord_guild_id text NOT NULL,
  discord_channel_id text NOT NULL,
  delete_rumor_id text NOT NULL,
  target_rumor_id text NOT NULL,
  author text NOT NULL,
  citation jsonb,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, community_id, concord_channel_id, discord_guild_id,
               discord_channel_id, delete_rumor_id, target_rumor_id)
);
CREATE INDEX pending_concord_deletes_target ON pending_concord_deletes
  (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id, target_rumor_id);
