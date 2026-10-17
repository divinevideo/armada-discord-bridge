CREATE TABLE IF NOT EXISTS moderation.coop_handoffs (
  case_id uuid PRIMARY KEY REFERENCES moderation.cases ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON moderation.coop_handoffs FROM PUBLIC, moderation_validator;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.coop_handoffs TO moderation_operator, moderation_reports;
