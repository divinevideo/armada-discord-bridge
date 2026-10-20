-- An active evidence hold can be extended, so evidence under an appeal or a
-- preservation obligation outlives a single hold window. Extension is audited
-- as its own lifecycle event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation.lifecycle_events'::regclass AND conname = 'lifecycle_events_kind_check'
    AND pg_get_constraintdef(oid) LIKE '%hold_extended%') THEN
    ALTER TABLE moderation.lifecycle_events DROP CONSTRAINT IF EXISTS lifecycle_events_kind_check;
    ALTER TABLE moderation.lifecycle_events ADD CONSTRAINT lifecycle_events_kind_check CHECK (kind IN ('hold_created', 'hold_extended', 'hold_released', 'held_evidence_access', 'appeal_opened', 'appeal_closed', 'lifecycle_closed', 'lifecycle_reopened'));
  END IF;
END $$;

-- Supersedes the 017 definition (017 replays first on every boot, then this).
-- The only new freedom is hold_until on an active hold, forward only, never in
-- the same statement as release, and only while the case's evidence row still
-- exists: a deadline must never be stretched over evidence that is gone, and a
-- lapsed or released hold must not be revived (that would be a new hold, which
-- placement refuses once evidence has expired). The configured maximum is
-- application policy; the database guarantees only monotonic, live extension.
CREATE OR REPLACE FUNCTION moderation.protect_lifecycle_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE bound_case uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'lifecycle_events' THEN
      IF (to_jsonb(NEW) - 'audit_delete_after') IS DISTINCT FROM (to_jsonb(OLD) - 'audit_delete_after') THEN RAISE EXCEPTION 'Lifecycle audit is immutable'; END IF;
    ELSE
      IF (to_jsonb(NEW) - ARRAY['released_at','audit_delete_after','hold_until']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','audit_delete_after','hold_until'])
        OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN RAISE EXCEPTION 'Lifecycle audit is immutable'; END IF;
      IF NEW.hold_until IS DISTINCT FROM OLD.hold_until THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(OLD.case_id::text)), 483217));
        IF OLD.released_at IS NOT NULL OR NEW.released_at IS NOT NULL OR OLD.hold_until <= clock_timestamp() OR NEW.hold_until < OLD.hold_until
          OR NOT EXISTS (SELECT 1 FROM moderation.cases WHERE org_id = OLD.org_id AND case_id = OLD.case_id) THEN
          RAISE EXCEPTION 'Evidence hold can only extend while active';
        END IF;
      END IF;
    END IF;
    IF OLD.audit_delete_after IS NOT NULL AND (NEW.audit_delete_after IS NULL OR NEW.audit_delete_after < OLD.audit_delete_after) THEN RAISE EXCEPTION 'Audit deadline cannot shorten'; END IF;
    RETURN NEW;
  END IF;
  bound_case := OLD.case_id;
  IF TG_TABLE_NAME = 'lifecycle_events' THEN
    bound_case := moderation.resolve_lifecycle_case(OLD.org_id, OLD.case_id, OLD.decision_id, OLD.hold_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(bound_case::text)), 483217));
  IF OLD.audit_delete_after IS NULL OR OLD.audit_delete_after > clock_timestamp() THEN RAISE EXCEPTION 'Lifecycle audit retention required'; END IF;
  IF EXISTS (SELECT 1 FROM moderation.evidence_holds h WHERE h.org_id = OLD.org_id AND h.case_id = bound_case AND h.released_at IS NULL AND h.hold_until > clock_timestamp())
    OR EXISTS (SELECT 1 FROM moderation.cases c WHERE c.org_id = OLD.org_id AND c.case_id = bound_case AND c.expires_at > clock_timestamp()) THEN RAISE EXCEPTION 'Case retention still active'; END IF;
  IF TG_TABLE_NAME = 'evidence_holds' THEN
    IF OLD.released_at IS NULL AND OLD.hold_until > clock_timestamp() THEN RAISE EXCEPTION 'Active evidence hold'; END IF;
  ELSE
    IF OLD.decision_id IS NOT NULL AND EXISTS (SELECT 1 FROM moderation.decisions WHERE decision_id = OLD.decision_id AND audit IS NOT NULL) THEN RAISE EXCEPTION 'Decision audit still retained'; END IF;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION moderation.protect_lifecycle_record() FROM PUBLIC;

-- 017's grants replay first and narrow hold updates; add only the deadline.
GRANT UPDATE (hold_until) ON moderation.evidence_holds TO moderation_api, moderation_operator;
