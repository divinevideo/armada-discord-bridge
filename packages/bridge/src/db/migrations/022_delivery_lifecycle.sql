-- Snapshot upgrade eligibility once. A later missing checkpoint is not evidence
-- that a newly linked channel may inherit historical delivery permissions.
CREATE TABLE channel_delivery_upgrade_eligibility (
 tenant_id text NOT NULL, community_id text NOT NULL, concord_channel_id text NOT NULL,
 discord_guild_id text NOT NULL, discord_channel_id text NOT NULL, owner_id text NOT NULL,
 legacy_boundaries jsonb NOT NULL DEFAULT '{}', consumed boolean NOT NULL DEFAULT false,
 PRIMARY KEY (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id, owner_id)
);
INSERT INTO channel_delivery_upgrade_eligibility
 (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,owner_id,legacy_boundaries)
SELECT l.tenant_id,l.community_id,l.concord_channel_id,l.discord_guild_id,l.discord_channel_id,l.owner_id,
 COALESCE((SELECT jsonb_object_agg(c.stream_pk,c.last_seen_at) FROM cursors c
 WHERE c.tenant_id=l.tenant_id AND c.community_id=l.community_id AND c.relay_url='pool'),'{}'::jsonb)
FROM (
 SELECT tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,bridge_id::text AS owner_id
 FROM bridges WHERE status IN ('active','paused') AND community_id IS NOT NULL AND concord_channel_id IS NOT NULL
 AND discord_guild_id IS NOT NULL AND discord_channel_id IS NOT NULL
 UNION ALL
 SELECT tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,
 'standalone:' || discord_guild_id || ':' || discord_channel_id || ':' || community_id || ':' || concord_channel_id
 FROM channel_links
) l ON CONFLICT DO NOTHING;
CREATE TABLE channel_delivery_lifecycles (
 tenant_id text NOT NULL, community_id text NOT NULL, concord_channel_id text NOT NULL,
 discord_guild_id text NOT NULL, discord_channel_id text NOT NULL,
 owner_id text NOT NULL, epoch uuid NOT NULL DEFAULT gen_random_uuid(), active boolean NOT NULL DEFAULT true,
 activation_floor bigint NOT NULL, version bigint NOT NULL DEFAULT 0,
 certified_until bigint, repair_floor bigint, coverage jsonb NOT NULL DEFAULT '{}',
 legacy_boundaries jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY (tenant_id, community_id, concord_channel_id, discord_guild_id, discord_channel_id)
);
ALTER TABLE pending_concord_deletes
 ADD COLUMN action_class text NOT NULL DEFAULT 'unresolved' CHECK (action_class IN ('unresolved','actionable')),
 ADD COLUMN source_wrap_created_at bigint,
 ADD COLUMN first_observed_at_ms bigint,
 ADD COLUMN expires_at_ms bigint,
 ADD COLUMN next_attempt_at_ms bigint NOT NULL DEFAULT 0,
 ADD COLUMN attempts integer NOT NULL DEFAULT 0;
-- Message mappings persist for the link lifetime; reaction retirement retains
-- the scoped parent/author evidence. Old mapped rows may already have reached
-- an effect, so retain them even when authority has since changed. An unmapped
-- row could never have reached an effect and keeps its original observation age.
UPDATE pending_concord_deletes p SET
 action_class=CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id=p.tenant_id
 AND m.community_id=p.community_id AND m.concord_channel_id=p.concord_channel_id
 AND m.discord_channel_id=p.discord_channel_id AND (m.concord_rumor_id=p.target_rumor_id
 OR EXISTS (SELECT 1 FROM reaction_mappings r WHERE r.tenant_id=p.tenant_id
 AND r.rumor_id=p.target_rumor_id AND r.discord_message_id=m.discord_message_id)))
 OR EXISTS (SELECT 1 FROM retired_concord_reactions r WHERE r.tenant_id=p.tenant_id
 AND r.community_id=p.community_id AND r.concord_channel_id=p.concord_channel_id
 AND r.discord_guild_id=p.discord_guild_id AND r.discord_channel_id=p.discord_channel_id
 AND r.rumor_id=p.target_rumor_id) THEN 'actionable' ELSE 'unresolved' END,
 source_wrap_created_at=created_at_ms/1000, first_observed_at_ms=created_at_ms;
UPDATE pending_concord_deletes SET expires_at_ms=least(created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000))+604800000
 WHERE action_class='unresolved';
CREATE INDEX pending_concord_deletes_due ON pending_concord_deletes
 (tenant_id,community_id,concord_channel_id,discord_guild_id,discord_channel_id,next_attempt_at_ms);
CREATE INDEX pending_concord_deletes_global_due ON pending_concord_deletes (tenant_id,next_attempt_at_ms);
