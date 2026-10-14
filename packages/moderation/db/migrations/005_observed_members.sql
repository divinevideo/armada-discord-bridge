-- Observed membership enables public profile discovery only. Authority stays in the control fold.
CREATE TABLE IF NOT EXISTS moderation.observed_members (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (community_id, author)
);
CREATE INDEX IF NOT EXISTS observed_members_author ON moderation.observed_members (author);
REVOKE ALL ON moderation.observed_members FROM PUBLIC;
GRANT SELECT, INSERT ON moderation.observed_members TO moderation_validator;
GRANT SELECT ON moderation.observed_members TO moderation_reports;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.observed_members TO moderation_operator;
