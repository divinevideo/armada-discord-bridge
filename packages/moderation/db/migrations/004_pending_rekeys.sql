ALTER TABLE moderation.streams DROP CONSTRAINT IF EXISTS streams_plane_check;
ALTER TABLE moderation.streams ADD CONSTRAINT streams_plane_check CHECK (plane IN ('chat', 'control', 'guestbook', 'rekey'));
ALTER TABLE moderation.streams ADD COLUMN IF NOT EXISTS previous_epoch numeric(20,0);
ALTER TABLE moderation.streams ADD COLUMN IF NOT EXISTS previous_commit text CHECK (previous_commit ~ '^[0-9a-f]{64}$');
CREATE TABLE IF NOT EXISTS moderation.rekey_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  epoch numeric(20,0) NOT NULL,
  event jsonb NOT NULL
);
REVOKE ALL ON moderation.rekey_events FROM PUBLIC;
GRANT SELECT, INSERT ON moderation.rekey_events TO moderation_validator;
GRANT SELECT ON moderation.rekey_events TO moderation_reports;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.rekey_events TO moderation_operator;
