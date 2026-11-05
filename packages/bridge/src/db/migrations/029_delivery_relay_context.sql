-- Certified inventory is meaningful only for its exact configured relay set.
-- Preserve prior ordinary stream progress independently of deletion replay.
ALTER TABLE channel_delivery_lifecycles
  ADD COLUMN relay_set jsonb,
  ADD COLUMN ordinary_coverage jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE channel_delivery_lifecycles SET ordinary_coverage=coverage;
