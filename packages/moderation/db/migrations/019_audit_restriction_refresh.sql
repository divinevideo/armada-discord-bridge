-- A Guild ban can change outside Concord while its control/source identity stays
-- unchanged. Require a new observation once retention elapses, rather than
-- using the absence seen when staff closed the lifecycle, potentially long ago.
-- This additive guard also fences older cleanup workers after bootstrap.
CREATE OR REPLACE FUNCTION moderation.protect_audit_restriction_refresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.audit IS NOT NULL AND NEW.audit IS NULL
    AND OLD.action IN ('ban_member', 'unban_member') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(OLD.case_id::text)), 483217));
    IF (EXISTS (SELECT 1 FROM moderation.decisions g
          WHERE g.org_id = OLD.org_id AND g.community_id = OLD.community_id
            AND g.author = OLD.author AND g.discord_guild_confirmed)
        OR EXISTS (SELECT 1 FROM moderation.member_order_heads h
          WHERE h.org_id = OLD.org_id AND h.community_id = OLD.community_id
            AND h.author = OLD.author AND (h.latest_guild_revision IS NOT NULL OR h.guild_scope_known_after > 0)))
      AND NOT EXISTS (SELECT 1 FROM moderation.deliveries d
        WHERE d.decision_id = OLD.decision_id AND d.target = 'discord'
          AND d.discord_restriction_checked_at >= OLD.audit_delete_after) THEN
      RAISE EXCEPTION 'Decision audit requires a post-retention Discord restriction observation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_audit_restriction_refresh ON moderation.decisions;
CREATE TRIGGER protect_audit_restriction_refresh BEFORE UPDATE OF audit ON moderation.decisions
  FOR EACH ROW EXECUTE FUNCTION moderation.protect_audit_restriction_refresh();
REVOKE ALL ON FUNCTION moderation.protect_audit_restriction_refresh() FROM PUBLIC;
