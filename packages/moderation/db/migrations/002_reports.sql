CREATE TABLE IF NOT EXISTS moderation.report_auth (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  reporter text NOT NULL CHECK (reporter ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS report_auth_by_reporter ON moderation.report_auth (reporter);
CREATE TABLE IF NOT EXISTS moderation.cases (
  case_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  community_id text NOT NULL CHECK (community_id ~ '^[0-9a-f]{64}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9a-f]{64}$'),
  rumor_id text NOT NULL CHECK (rumor_id ~ '^[0-9a-f]{64}$'),
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  fingerprint text UNIQUE NOT NULL,
  evidence bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS moderation.decisions (
  decision_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  execution_id text NOT NULL,
  fingerprint text NOT NULL,
  case_id uuid NOT NULL,
  community_id text NOT NULL,
  channel_id text NOT NULL,
  rumor_id text NOT NULL,
  author text NOT NULL,
  action text NOT NULL CHECK (action IN ('remove_message', 'ban_member', 'unban_member')),
  discord_guild_confirmed boolean NOT NULL,
  audit bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (org_id, execution_id)
);
CREATE TABLE IF NOT EXISTS moderation.deliveries (
  decision_id uuid NOT NULL REFERENCES moderation.decisions ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('divine_relay', 'concord', 'discord')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acknowledged', 'verified', 'failed', 'not_applicable')),
  attempts integer NOT NULL DEFAULT 0,
  token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_events jsonb,
  result_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (decision_id, target)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moderation_reports') THEN
    CREATE ROLE moderation_reports NOLOGIN;
  END IF;
END $$;
REVOKE ALL ON moderation.report_auth, moderation.cases, moderation.decisions, moderation.deliveries FROM PUBLIC, moderation_validator;
GRANT USAGE ON SCHEMA moderation TO moderation_reports;
GRANT SELECT ON moderation.community_policy, moderation.streams, moderation.member_bans, moderation.carriers TO moderation_reports;
GRANT SELECT, INSERT, DELETE ON moderation.report_auth, moderation.cases TO moderation_reports;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.report_auth, moderation.cases, moderation.decisions, moderation.deliveries TO moderation_operator;
