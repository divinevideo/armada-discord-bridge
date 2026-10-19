-- Evidence expiry cannot determine the lifetime of action audit or execution facts.
ALTER TABLE moderation.decisions
  ADD COLUMN IF NOT EXISTS reverses_decision_id uuid,
  ADD COLUMN IF NOT EXISTS lifecycle_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS audit_delete_after timestamptz,
  ADD COLUMN IF NOT EXISTS audit_retention_seconds bigint,
  ADD COLUMN IF NOT EXISTS appeal_state text NOT NULL DEFAULT 'none';
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_identity ON moderation.decisions (org_id, decision_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation.decisions'::regclass AND conname = 'decisions_lifecycle') THEN
    ALTER TABLE moderation.decisions ADD CONSTRAINT decisions_lifecycle CHECK (
      appeal_state IN ('none', 'open', 'closed')
      AND (audit_retention_seconds IS NULL OR audit_retention_seconds > 0)
      AND (audit_delete_after IS NULL OR (lifecycle_closed_at IS NOT NULL AND audit_retention_seconds IS NOT NULL AND audit_delete_after >= lifecycle_closed_at))
      AND (reverses_decision_id IS NULL OR (action = 'unban_member' AND reverses_decision_id <> decision_id)));
    ALTER TABLE moderation.decisions ADD CONSTRAINT decisions_reversal_org FOREIGN KEY (org_id, reverses_decision_id)
      REFERENCES moderation.decisions (org_id, decision_id) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE moderation.decisions DROP CONSTRAINT decisions_source_order;
ALTER TABLE moderation.decisions ADD CONSTRAINT decisions_source_order CHECK (
  (reverses_decision_id IS NULL AND (
    (source_order_version IS NULL AND source_revision IS NULL AND (fingerprint_version = 1 OR (fingerprint_version = 2 AND action = 'remove_message')))
    OR (source_order_version IS NOT NULL AND source_order_version = 1 AND source_revision > 0 AND source_revision IS NOT NULL AND fingerprint_version = 2 AND action IN ('ban_member', 'unban_member'))))
  OR (reverses_decision_id IS NOT NULL AND fingerprint_version = 3 AND action = 'unban_member'
    AND source_order_version IS NOT NULL AND source_order_version = 1 AND source_revision IS NOT NULL AND source_revision > 0));

CREATE TABLE IF NOT EXISTS moderation.evidence_holds (
  hold_id uuid PRIMARY KEY, org_id text NOT NULL, case_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), hold_until timestamptz NOT NULL,
  released_at timestamptz, encrypted_audit bytea NOT NULL, audit_delete_after timestamptz,
  UNIQUE (org_id, hold_id),
  CHECK (hold_until > created_at), CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (audit_delete_after IS NULL OR audit_delete_after >= hold_until OR (released_at IS NOT NULL AND audit_delete_after >= released_at))
);
CREATE INDEX IF NOT EXISTS evidence_holds_active ON moderation.evidence_holds (org_id, case_id, hold_until) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS moderation.lifecycle_events (
  event_id uuid PRIMARY KEY, org_id text NOT NULL, decision_id uuid, case_id uuid, hold_id uuid,
  kind text NOT NULL CHECK (kind IN ('hold_created', 'hold_released', 'held_evidence_access', 'appeal_opened', 'appeal_closed', 'lifecycle_closed', 'lifecycle_reopened')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), encrypted_audit bytea NOT NULL, audit_delete_after timestamptz,
  CHECK (num_nonnulls(decision_id, case_id, hold_id) > 0),
  CHECK (audit_delete_after IS NULL OR audit_delete_after >= recorded_at),
  FOREIGN KEY (org_id, decision_id) REFERENCES moderation.decisions (org_id, decision_id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, hold_id) REFERENCES moderation.evidence_holds (org_id, hold_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS lifecycle_events_retention ON moderation.lifecycle_events (audit_delete_after) WHERE audit_delete_after IS NOT NULL;
CREATE TABLE IF NOT EXISTS moderation.discord_member_bindings (
  org_id text NOT NULL, community_id text NOT NULL CHECK (community_id ~ '^[0-9a-f]{64}$'),
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  guild_id text NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'), channel_id text NOT NULL CHECK (channel_id ~ '^[0-9]{17,20}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[0-9]{17,20}$'), verified_at timestamptz NOT NULL,
  provenance_decision_id uuid NOT NULL, PRIMARY KEY (org_id, community_id, author),
  FOREIGN KEY (org_id, provenance_decision_id) REFERENCES moderation.decisions (org_id, decision_id) ON DELETE RESTRICT
);
ALTER TABLE moderation.deliveries
  ADD COLUMN IF NOT EXISTS discord_restriction_state text NOT NULL DEFAULT 'unknown' CHECK (discord_restriction_state IN ('present', 'absent', 'unknown', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS discord_restriction_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS discord_restriction_code text NOT NULL DEFAULT 'not_checked';

-- A raw expiry DELETE must share the case boundary with hold placement.
CREATE OR REPLACE FUNCTION moderation.protect_held_case() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(OLD.org_id), to_json(OLD.case_id::text)), 483217));
  IF EXISTS (SELECT 1 FROM moderation.evidence_holds WHERE org_id = OLD.org_id AND case_id = OLD.case_id AND released_at IS NULL AND hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'Active evidence hold prevents deletion';
  END IF;
  RETURN OLD;
END $$;
-- Every reference names one original case, including after its evidence is gone.
CREATE OR REPLACE FUNCTION moderation.resolve_lifecycle_case(org text, explicit_case uuid, decision uuid, hold uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE bound_case uuid := explicit_case; referenced_case uuid;
BEGIN
  IF decision IS NOT NULL THEN
    SELECT case_id INTO referenced_case FROM moderation.decisions WHERE org_id = org AND decision_id = decision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle reference violates same-organization foreign key'; END IF;
    IF bound_case IS NOT NULL AND bound_case <> referenced_case THEN RAISE EXCEPTION 'Lifecycle case reference mismatch'; END IF;
    bound_case := referenced_case;
  END IF;
  IF hold IS NOT NULL THEN
    SELECT case_id INTO referenced_case FROM moderation.evidence_holds WHERE org_id = org AND hold_id = hold;
    IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle reference violates same-organization foreign key'; END IF;
    IF bound_case IS NOT NULL AND bound_case <> referenced_case THEN RAISE EXCEPTION 'Lifecycle case reference mismatch'; END IF;
    bound_case := referenced_case;
  END IF;
  IF bound_case IS NULL THEN RAISE EXCEPTION 'Lifecycle case unavailable'; END IF;
  RETURN bound_case;
END $$;
CREATE OR REPLACE FUNCTION moderation.bind_lifecycle_case() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE case_exists boolean;
BEGIN
  IF TG_TABLE_NAME = 'lifecycle_events' THEN
    NEW.case_id := moderation.resolve_lifecycle_case(NEW.org_id, NEW.case_id, NEW.decision_id, NEW.hold_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(NEW.org_id), to_json(NEW.case_id::text)), 483217));
  PERFORM 1 FROM moderation.cases WHERE org_id = NEW.org_id AND case_id = NEW.case_id FOR UPDATE;
  case_exists := FOUND;
  IF NOT case_exists THEN
    IF TG_TABLE_NAME = 'evidence_holds' THEN RAISE EXCEPTION 'Lifecycle case unavailable'; END IF;
    IF NEW.decision_id IS NULL AND NEW.hold_id IS NULL THEN RAISE EXCEPTION 'Lifecycle case unavailable'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM moderation.cases WHERE case_id = NEW.case_id AND org_id <> NEW.org_id) THEN RAISE EXCEPTION 'Lifecycle case organization mismatch'; END IF;
  RETURN NEW;
END $$;
-- Keep acceptance immutable even if a future bootstrap accidentally widens grants.
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
      OR OLD.appeal_state = 'open' OR NEW.appeal_state = 'open' OR OLD.action = 'ban_member'
      OR EXISTS (SELECT 1 FROM moderation.evidence_holds h WHERE h.org_id = OLD.org_id AND h.case_id = OLD.case_id AND h.released_at IS NULL AND h.hold_until > clock_timestamp())
      OR EXISTS (SELECT 1 FROM moderation.deliveries d WHERE d.decision_id = OLD.decision_id AND (d.state NOT IN ('verified','not_applicable') OR d.lease_until > clock_timestamp()
        OR (d.publication_attempted AND d.state <> 'verified') OR d.discord_restriction_state = 'present' OR (d.target = 'discord' AND OLD.discord_guild_confirmed AND d.discord_restriction_state = 'unknown'))) THEN
      RAISE EXCEPTION 'Decision audit is not eligible for cleanup';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION moderation.protect_lifecycle_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE bound_case uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'lifecycle_events' THEN
      IF (to_jsonb(NEW) - 'audit_delete_after') IS DISTINCT FROM (to_jsonb(OLD) - 'audit_delete_after') THEN RAISE EXCEPTION 'Lifecycle audit is immutable'; END IF;
    ELSE
      IF (to_jsonb(NEW) - ARRAY['released_at','audit_delete_after']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','audit_delete_after'])
        OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN RAISE EXCEPTION 'Lifecycle audit is immutable'; END IF;
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
DROP TRIGGER IF EXISTS protect_held_case ON moderation.cases;
CREATE TRIGGER protect_held_case BEFORE DELETE ON moderation.cases FOR EACH ROW EXECUTE FUNCTION moderation.protect_held_case();
DROP TRIGGER IF EXISTS bind_lifecycle_case ON moderation.evidence_holds;
CREATE TRIGGER bind_lifecycle_case BEFORE INSERT ON moderation.evidence_holds FOR EACH ROW EXECUTE FUNCTION moderation.bind_lifecycle_case();
DROP TRIGGER IF EXISTS bind_lifecycle_case ON moderation.lifecycle_events;
CREATE TRIGGER bind_lifecycle_case BEFORE INSERT ON moderation.lifecycle_events FOR EACH ROW EXECUTE FUNCTION moderation.bind_lifecycle_case();
DROP TRIGGER IF EXISTS protect_decision_audit ON moderation.decisions;
CREATE TRIGGER protect_decision_audit BEFORE UPDATE ON moderation.decisions FOR EACH ROW EXECUTE FUNCTION moderation.protect_decision_audit();
DROP TRIGGER IF EXISTS protect_lifecycle_record ON moderation.evidence_holds;
CREATE TRIGGER protect_lifecycle_record BEFORE UPDATE OR DELETE ON moderation.evidence_holds FOR EACH ROW EXECUTE FUNCTION moderation.protect_lifecycle_record();
DROP TRIGGER IF EXISTS protect_lifecycle_record ON moderation.lifecycle_events;
CREATE TRIGGER protect_lifecycle_record BEFORE UPDATE OR DELETE ON moderation.lifecycle_events FOR EACH ROW EXECUTE FUNCTION moderation.protect_lifecycle_record();
REVOKE ALL ON FUNCTION moderation.protect_held_case(), moderation.bind_lifecycle_case(), moderation.protect_decision_audit(), moderation.protect_lifecycle_record() FROM PUBLIC;

-- Earlier bootstrap grants replay on every start; narrow these last, every time.
REVOKE UPDATE, DELETE ON moderation.decisions FROM moderation_api, moderation_operator;
GRANT UPDATE (audit, lifecycle_closed_at, audit_delete_after, audit_retention_seconds, appeal_state) ON moderation.decisions TO moderation_api, moderation_operator;
REVOKE ALL ON moderation.evidence_holds, moderation.lifecycle_events, moderation.discord_member_bindings FROM PUBLIC, moderation_validator, moderation_reports, moderation_api, moderation_operator;
GRANT SELECT, INSERT ON moderation.evidence_holds, moderation.lifecycle_events TO moderation_api, moderation_operator;
GRANT UPDATE (released_at, audit_delete_after) ON moderation.evidence_holds TO moderation_api, moderation_operator;
GRANT DELETE ON moderation.evidence_holds, moderation.lifecycle_events TO moderation_operator;
GRANT SELECT ON moderation.evidence_holds TO moderation_reports;
GRANT SELECT ON moderation.discord_member_bindings TO moderation_api, moderation_operator;
GRANT INSERT, UPDATE ON moderation.discord_member_bindings TO moderation_operator;

GRANT UPDATE (audit_delete_after) ON moderation.lifecycle_events TO moderation_operator;

REVOKE ALL ON FUNCTION moderation.resolve_lifecycle_case(text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION moderation.resolve_lifecycle_case(text, uuid, uuid, uuid) TO moderation_api, moderation_operator;

-- Hold deadlines retain the explicit policy even when launch configuration changes.
ALTER TABLE moderation.evidence_holds ADD COLUMN IF NOT EXISTS audit_retention_seconds bigint CHECK (audit_retention_seconds > 0), ADD COLUMN IF NOT EXISTS case_expires_at timestamptz;
