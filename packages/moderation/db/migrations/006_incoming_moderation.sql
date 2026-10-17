CREATE TABLE IF NOT EXISTS moderation.accepted_control (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  event jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS accepted_control_community ON moderation.accepted_control (community_id);
CREATE TABLE IF NOT EXISTS moderation.incoming_removals (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  rumor_id text NOT NULL CHECK (rumor_id ~ '^[0-9a-f]{64}$'),
  decision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  verified boolean NOT NULL DEFAULT false,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, channel_id, rumor_id)
);
REVOKE ALL ON moderation.accepted_control, moderation.incoming_removals FROM PUBLIC;
GRANT SELECT, INSERT ON moderation.accepted_control, moderation.incoming_removals TO moderation_validator;
GRANT INSERT ON moderation.tombstones TO moderation_validator;
GRANT SELECT ON moderation.accepted_control TO moderation_reports;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.accepted_control, moderation.incoming_removals TO moderation_operator;
