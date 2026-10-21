-- Recovery never replenishes the delivery budget or forgets original identity.
ALTER TABLE moderation.deliveries ADD COLUMN IF NOT EXISTS recovery_version integer NOT NULL DEFAULT 0;
ALTER TABLE moderation.deliveries ADD COLUMN IF NOT EXISTS publication_metadata jsonb;
CREATE TABLE IF NOT EXISTS moderation.publication_recoveries (
  recovery_id uuid PRIMARY KEY, decision_id uuid NOT NULL, org_id text NOT NULL,
  recovery_version integer NOT NULL, event_id text NOT NULL CHECK (event_id ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('replay','prove')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (decision_id, recovery_version)
);
REVOKE ALL ON moderation.publication_recoveries FROM PUBLIC, moderation_reports, moderation_api, moderation_validator, moderation_operator;
GRANT SELECT, INSERT ON moderation.publication_recoveries TO moderation_operator;
CREATE OR REPLACE FUNCTION moderation.immutable_publication_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publication recovery audit is immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_publication_recovery ON moderation.publication_recoveries;
CREATE TRIGGER immutable_publication_recovery BEFORE UPDATE OR DELETE ON moderation.publication_recoveries
  FOR EACH ROW EXECUTE FUNCTION moderation.immutable_publication_recovery();

-- Actor/reason use the existing lifecycle audit retention and erasure rules.
-- Opaque recovery ordering remains after deliberate lifecycle audit cleanup.
ALTER TABLE moderation.lifecycle_events DROP CONSTRAINT IF EXISTS lifecycle_events_kind_check;
ALTER TABLE moderation.lifecycle_events ADD CONSTRAINT lifecycle_events_kind_check CHECK (kind IN (
 'hold_created','hold_extended','hold_released','held_evidence_access','appeal_opened','appeal_closed','lifecycle_closed','lifecycle_reopened','publication_recovery'));
