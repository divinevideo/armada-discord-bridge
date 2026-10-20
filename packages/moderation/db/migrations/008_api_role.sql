DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moderation_api') THEN
    CREATE ROLE moderation_api NOLOGIN;
  END IF;
END $$;
GRANT moderation_reports TO moderation_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON moderation.decisions, moderation.deliveries TO moderation_api;
-- Relay policy, bans and tombstones are deliberately not writable by the API.
