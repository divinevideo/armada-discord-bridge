-- Keep the existing source-order ledger and its lifetime. Scope metadata is
-- additive; absence of a historical decision cannot prove it was community-only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'moderation.member_order_heads'::regclass AND attname = 'latest_guild_revision' AND NOT attisdropped) THEN
    ALTER TABLE moderation.member_order_heads ADD COLUMN latest_guild_revision bigint;
    ALTER TABLE moderation.member_order_heads ADD COLUMN guild_scope_known_after bigint NOT NULL DEFAULT 0;
    DROP TRIGGER preserve_member_order_head ON moderation.member_order_heads;
    UPDATE moderation.member_order_heads h SET guild_scope_known_after = h.latest_revision,
      latest_guild_revision = (SELECT max(c.source_revision) FROM moderation.decisions c
        WHERE c.org_id = h.org_id AND c.community_id = h.community_id AND c.author = h.author
          AND c.action IN ('ban_member', 'unban_member') AND c.discord_guild_confirmed);
    CREATE TRIGGER preserve_member_order_head BEFORE UPDATE ON moderation.member_order_heads
      FOR EACH ROW EXECUTE FUNCTION moderation.preserve_member_order_head();
    ALTER TABLE moderation.member_order_heads ADD CONSTRAINT member_guild_scope_order CHECK (
      guild_scope_known_after >= 0 AND guild_scope_known_after <= latest_revision
      AND (latest_guild_revision IS NULL OR (latest_guild_revision > 0 AND latest_guild_revision <= latest_revision)));
  END IF;
END $$;
GRANT UPDATE (latest_guild_revision) ON moderation.member_order_heads TO moderation_api;
CREATE OR REPLACE FUNCTION moderation.preserve_member_order_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.latest_revision <= OLD.latest_revision OR NEW.guild_scope_known_after <> OLD.guild_scope_known_after
    OR (OLD.latest_guild_revision IS NOT NULL AND (NEW.latest_guild_revision IS NULL OR NEW.latest_guild_revision < OLD.latest_guild_revision)) THEN
    RAISE EXCEPTION 'Membership source revision must advance without losing Guild scope';
  END IF;
  RETURN NEW;
END $$;
-- An old executable may know the global fence but omit the Guild fence.
-- Refuse its Guild INSERT rather than accept intent without durable ordering.
CREATE OR REPLACE FUNCTION moderation.require_guild_order_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.action IN ('ban_member', 'unban_member') AND NEW.discord_guild_confirmed
    AND (NEW.source_revision IS NULL OR NOT EXISTS (SELECT 1 FROM moderation.member_order_heads h
      WHERE h.org_id = NEW.org_id AND h.community_id = NEW.community_id AND h.author = NEW.author
        AND h.latest_revision = NEW.source_revision AND h.latest_execution_id::text = NEW.execution_id AND h.latest_guild_revision = NEW.source_revision)) THEN
    RAISE EXCEPTION 'Guild membership source-order head required';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION moderation.require_guild_order_head() FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.decisions'::regclass AND tgname = 'require_guild_order_head') THEN
    CREATE TRIGGER require_guild_order_head BEFORE INSERT ON moderation.decisions
      FOR EACH ROW EXECUTE FUNCTION moderation.require_guild_order_head();
  END IF;
END $$;
