-- Additive: existing exact replay hashes retain their original algorithm.
ALTER TABLE moderation.decisions ADD COLUMN IF NOT EXISTS fingerprint_version smallint NOT NULL DEFAULT 1;
ALTER TABLE moderation.decisions ADD COLUMN IF NOT EXISTS source_order_version smallint;
ALTER TABLE moderation.decisions ADD COLUMN IF NOT EXISTS source_revision bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation.decisions'::regclass AND conname = 'decisions_source_order') THEN
    ALTER TABLE moderation.decisions ADD CONSTRAINT decisions_source_order CHECK (
      (source_order_version IS NULL AND source_revision IS NULL AND (fingerprint_version = 1 OR (fingerprint_version = 2 AND action = 'remove_message')))
      OR (source_order_version IS NOT NULL AND source_order_version = 1 AND source_revision IS NOT NULL AND source_revision > 0 AND fingerprint_version = 2 AND action IN ('ban_member', 'unban_member')));
  END IF;
END $$;
-- No case/decision FK: evidence pruning must never make an old request new.
CREATE TABLE IF NOT EXISTS moderation.member_order_heads (
  org_id text NOT NULL,
  community_id text NOT NULL CHECK (community_id ~ '^[0-9a-f]{64}$'),
  author text NOT NULL CHECK (author ~ '^[0-9a-f]{64}$'),
  latest_revision bigint NOT NULL CHECK (latest_revision > 0),
  latest_execution_id uuid NOT NULL,
  PRIMARY KEY (org_id, community_id, author)
);
CREATE INDEX IF NOT EXISTS decisions_member_source_order ON moderation.decisions (org_id, community_id, author, source_revision)
  WHERE action IN ('ban_member', 'unban_member');
REVOKE ALL ON moderation.member_order_heads FROM PUBLIC, moderation_validator, moderation_reports, moderation_api;
GRANT SELECT, INSERT ON moderation.member_order_heads TO moderation_api;
GRANT UPDATE (latest_revision, latest_execution_id) ON moderation.member_order_heads TO moderation_api;
GRANT SELECT ON moderation.member_order_heads TO moderation_operator;
-- 001 is reapplied on boot and grants the operator every table. Narrow this
-- durable ledger again so worker expiry/cleanup can never recycle its counter.
REVOKE ALL ON moderation.member_order_heads FROM moderation_operator;
GRANT SELECT ON moderation.member_order_heads TO moderation_operator;
CREATE OR REPLACE FUNCTION moderation.preserve_member_order_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.latest_revision <= OLD.latest_revision THEN
    RAISE EXCEPTION 'Membership source revision must advance';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION moderation.preserve_member_order_head() FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.member_order_heads'::regclass AND tgname = 'preserve_member_order_head') THEN
    CREATE TRIGGER preserve_member_order_head BEFORE UPDATE ON moderation.member_order_heads
      FOR EACH ROW EXECUTE FUNCTION moderation.preserve_member_order_head();
  END IF;
END $$;

-- Existing rows were backfilled with version 1 above. An older executable
-- omitting all new columns now gets version 2, so its unfenced membership
-- INSERT fails the source-order constraint rather than reopening old ordering.
ALTER TABLE moderation.decisions ALTER COLUMN fingerprint_version SET DEFAULT 2;
