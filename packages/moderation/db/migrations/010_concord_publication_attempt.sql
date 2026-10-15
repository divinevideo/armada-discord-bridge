-- Existing persisted bytes may already have reached a relay. Neither attempts
-- nor a failed result proves otherwise; only the new persist-before-send path
-- can record an unattempted generation. Never backfill these rows to false.
ALTER TABLE moderation.deliveries
  ADD COLUMN IF NOT EXISTS publication_attempted boolean NOT NULL DEFAULT true;
