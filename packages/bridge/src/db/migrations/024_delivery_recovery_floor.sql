-- Preserve the earliest trustworthy upgrade boundary after a repair clears.
-- Intermediate deployments may already have erased older evidence; do not
-- invent a boundary that the remaining rows cannot establish.
ALTER TABLE channel_delivery_lifecycles ADD COLUMN recovery_floor bigint;
UPDATE channel_delivery_lifecycles l SET recovery_floor = LEAST(
  l.activation_floor,
  COALESCE(l.repair_floor, l.activation_floor),
  COALESCE((SELECT min(value::bigint) FROM jsonb_each_text(l.legacy_boundaries)), l.activation_floor),
  COALESCE((SELECT c.last_seen_at FROM channel_delivery_checkpoints c
    WHERE c.tenant_id=l.tenant_id AND c.community_id=l.community_id
      AND c.concord_channel_id=l.concord_channel_id AND c.discord_guild_id=l.discord_guild_id
      AND c.discord_channel_id=l.discord_channel_id), l.activation_floor)
);
ALTER TABLE channel_delivery_lifecycles ALTER COLUMN recovery_floor SET NOT NULL;
