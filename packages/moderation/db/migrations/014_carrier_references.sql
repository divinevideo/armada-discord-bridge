-- Existing encrypted carriers cannot be assigned targets by a SQL guess.
-- Purge/evidence fail closed on legacy edits/reactions until verified reindexing.
ALTER TABLE moderation.carriers ADD COLUMN IF NOT EXISTS target_rumor_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE moderation.carriers ADD COLUMN IF NOT EXISTS targets_indexed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS carriers_by_references ON moderation.carriers USING gin (target_rumor_ids);
GRANT UPDATE (target_rumor_ids, targets_indexed) ON moderation.carriers TO moderation_validator;
GRANT SELECT ON moderation.tombstones TO moderation_reports;
