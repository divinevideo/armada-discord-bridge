-- Older accepted rows have no trustworthy inner epoch or rumor time. Preserve
-- them without inventing provenance; new intake retains both for cutoff checks.
ALTER TABLE pending_concord_deletes
  ADD COLUMN inner_created_at bigint,
  ADD COLUMN inner_epoch text;
