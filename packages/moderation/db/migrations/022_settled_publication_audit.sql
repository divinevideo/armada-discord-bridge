-- Canonical readback records a settled observation, not a new send. Align
-- audit erasure with the application's exact settled receipt codes while
-- retaining all closure, retention, appeal, hold and restriction predicates.
-- The state/code pair must match resolvedConcordReceipt in src/concordDelivery.ts.
-- Owner supersession resolves uncertainty without proving the old action was
-- applied. All other closure, current unban, restriction and retention gates
-- still apply before erasure; relay/reversal proof uses the narrower predicate.
-- No existing rows/deadlines are rewritten. 017 replays first on boot.
CREATE OR REPLACE FUNCTION moderation.protect_decision_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['audit','lifecycle_closed_at','audit_delete_after','audit_retention_seconds','appeal_state'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['audit','lifecycle_closed_at','audit_delete_after','audit_retention_seconds','appeal_state']) THEN
    RAISE EXCEPTION 'Decision acceptance is immutable';
  END IF;
  IF OLD.lifecycle_closed_at IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(OLD.case_id::text)), 483217));
    IF NEW.lifecycle_closed_at IS NULL THEN
      -- Reopening explicitly drops the deadline, without purging audit or
      -- substituting a new policy snapshot in the same transition.
      IF NEW.audit_delete_after IS NOT NULL OR NEW.audit IS DISTINCT FROM OLD.audit
        OR (NEW.audit_retention_seconds IS NOT NULL AND NEW.audit_retention_seconds IS DISTINCT FROM OLD.audit_retention_seconds) THEN
        RAISE EXCEPTION 'Invalid lifecycle reopening retention transition';
      END IF;
    ELSE
      IF NEW.lifecycle_closed_at IS DISTINCT FROM OLD.lifecycle_closed_at THEN RAISE EXCEPTION 'Lifecycle closure is immutable until reopened'; END IF;
      IF NEW.audit_retention_seconds IS DISTINCT FROM OLD.audit_retention_seconds THEN RAISE EXCEPTION 'Closed lifecycle retention snapshot is immutable'; END IF;
      IF OLD.audit_delete_after IS NOT NULL AND (NEW.audit_delete_after IS NULL OR NEW.audit_delete_after < OLD.audit_delete_after) THEN RAISE EXCEPTION 'Decision audit deadline cannot shorten'; END IF;
    END IF;
  END IF;
  IF NEW.audit IS DISTINCT FROM OLD.audit THEN
    IF NEW.audit IS NOT NULL THEN RAISE EXCEPTION 'Decision audit is immutable'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(OLD.case_id::text)), 483217));
    IF OLD.lifecycle_closed_at IS NULL OR OLD.audit_delete_after IS NULL OR OLD.audit_delete_after > clock_timestamp()
      OR NEW.lifecycle_closed_at IS DISTINCT FROM OLD.lifecycle_closed_at OR NEW.audit_delete_after IS DISTINCT FROM OLD.audit_delete_after
      OR OLD.appeal_state = 'open' OR NEW.appeal_state = 'open'
      OR (OLD.action IN ('ban_member','unban_member') AND (
        NOT EXISTS (SELECT 1 FROM moderation.member_order_heads h JOIN moderation.decisions n ON n.org_id = h.org_id AND n.community_id = h.community_id AND n.author = h.author AND n.source_revision = h.latest_revision AND n.execution_id = h.latest_execution_id::text
          WHERE h.org_id = OLD.org_id AND h.community_id = OLD.community_id AND h.author = OLD.author AND n.action = 'unban_member'
            AND EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = n.decision_id AND d.target = 'concord' AND
              (d.state = 'verified' OR (d.state = 'not_applicable' AND d.result_code IN ('concord_publication_settled','concord_superseded_publication_settled'))))
            AND EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = n.decision_id AND d.target = 'divine_relay' AND d.state = 'verified'))
        OR EXISTS (SELECT 1 FROM moderation.member_bans b WHERE b.community_id = OLD.community_id AND b.author = OLD.author AND b.blocked)
        OR NOT EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = OLD.decision_id AND d.target = 'discord' AND d.discord_restriction_checked_at >= d.available_at
          AND d.discord_restriction_proof_key = (SELECT encode(sha256(convert_to(jsonb_build_array(
            p.payload->>'rootEpoch',
            (SELECT jsonb_agg(e.id ORDER BY e.id) FROM (SELECT value->>'id' AS id FROM jsonb_array_elements(p.payload->'controlEvents') UNION SELECT event->>'id' FROM moderation.accepted_control WHERE community_id = p.community_id) e),
            (SELECT to_jsonb(h) FROM moderation.member_order_heads h WHERE h.org_id = OLD.org_id AND h.community_id = p.community_id AND h.author = OLD.author),
            COALESCE((SELECT blocked FROM moderation.member_bans b WHERE b.community_id = p.community_id AND b.author = OLD.author), false)
          )::text, 'UTF8')), 'hex') FROM moderation.community_policy p WHERE p.community_id = OLD.community_id AND (p.payload->>'complete')::boolean AND (p.payload->>'validUntil')::numeric > extract(epoch FROM clock_timestamp()) * 1000)
          AND (d.discord_restriction_state = 'absent' OR (d.discord_restriction_state = 'not_applicable'
            AND NOT EXISTS (SELECT 1 FROM moderation.decisions g WHERE g.org_id = OLD.org_id AND g.community_id = OLD.community_id AND g.author = OLD.author AND g.discord_guild_confirmed)
            AND NOT EXISTS (SELECT 1 FROM moderation.member_order_heads h WHERE h.org_id = OLD.org_id AND h.community_id = OLD.community_id AND h.author = OLD.author AND (h.latest_guild_revision IS NOT NULL OR h.guild_scope_known_after > 0)))))))
      OR EXISTS (SELECT 1 FROM moderation.evidence_holds h WHERE h.org_id = OLD.org_id AND h.case_id = OLD.case_id AND h.released_at IS NULL AND h.hold_until > clock_timestamp())
      OR EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = OLD.decision_id AND (d.state NOT IN ('verified','not_applicable') OR d.lease_until > clock_timestamp()
        OR (d.target = 'concord' AND d.publication_attempted AND d.state <> 'verified'
          AND NOT COALESCE(d.state = 'not_applicable' AND d.result_code IN ('concord_publication_settled','concord_superseded_publication_settled','concord_operator_superseded'), false)) OR d.discord_restriction_state = 'present' OR (d.target = 'discord' AND OLD.discord_guild_confirmed AND d.discord_restriction_state = 'unknown'))) THEN
      RAISE EXCEPTION 'Decision audit is not eligible for cleanup';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION moderation.protect_decision_audit() FROM PUBLIC;
