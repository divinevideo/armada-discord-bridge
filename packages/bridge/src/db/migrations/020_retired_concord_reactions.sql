-- Preserve target authority after removing an active reaction mapping. Later
-- distinct delete rumors and crash replay must not become unknowable targets;
-- keeping this separate leaves Discord re-add lookups strictly active-only.
CREATE TABLE retired_concord_reactions (
  tenant_id text NOT NULL,
  community_id text NOT NULL,
  concord_channel_id text NOT NULL,
  discord_guild_id text NOT NULL,
  discord_channel_id text NOT NULL,
  rumor_id text NOT NULL,
  discord_message_id text NOT NULL,
  emoji text NOT NULL,
  origin text NOT NULL,
  author_ref text NOT NULL,
  PRIMARY KEY (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id, rumor_id)
);
