CREATE SCHEMA IF NOT EXISTS moderation;
CREATE TABLE IF NOT EXISTS moderation.community_policy (
  community_id text PRIMARY KEY CHECK (community_id ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS moderation.streams (
  pubkey text PRIMARY KEY CHECK (pubkey ~ '^[0-9a-f]{64}$'),
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  channel_id text CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  plane text NOT NULL CHECK (plane IN ('chat', 'control', 'guestbook')),
  epoch numeric(20,0) NOT NULL CHECK (epoch >= 0),
  read_key bytea NOT NULL CHECK (octet_length(read_key) = 32),
  restricted boolean NOT NULL,
  CHECK ((plane = 'chat') = (channel_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS moderation.member_bans (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  blocked boolean NOT NULL,
  PRIMARY KEY (community_id, author)
);
CREATE TABLE IF NOT EXISTS moderation.tombstones (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  rumor_id text NOT NULL CHECK (rumor_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, channel_id, rumor_id)
);
CREATE TABLE IF NOT EXISTS moderation.carriers (
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  rumor_id text NOT NULL CHECK (rumor_id ~ '^[0-9a-f]{64}$'),
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  kind integer NOT NULL,
  policy_revision bigint NOT NULL,
  expires_at timestamptz,
  indexed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS carriers_by_target ON moderation.carriers (community_id, channel_id, rumor_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moderation_validator') THEN
    CREATE ROLE moderation_validator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moderation_operator') THEN
    CREATE ROLE moderation_operator NOLOGIN;
  END IF;
END $$;
REVOKE ALL ON SCHEMA moderation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA moderation FROM PUBLIC;
GRANT USAGE ON SCHEMA moderation TO moderation_validator, moderation_operator;
GRANT SELECT ON moderation.community_policy, moderation.streams, moderation.member_bans, moderation.tombstones, moderation.carriers TO moderation_validator;
GRANT INSERT ON moderation.carriers TO moderation_validator;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA moderation TO moderation_operator;

CREATE TABLE IF NOT EXISTS moderation.removals (
  decision_id uuid PRIMARY KEY,
  community_id text NOT NULL REFERENCES moderation.community_policy ON DELETE CASCADE,
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  rumor_id text NOT NULL CHECK (rumor_id ~ '^[0-9a-f]{64}$'),
  policy_revision bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verified', 'failed')),
  attempts integer NOT NULL DEFAULT 1,
  verified_at timestamptz
);
REVOKE ALL ON moderation.removals FROM PUBLIC, moderation_validator;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.removals TO moderation_operator;
