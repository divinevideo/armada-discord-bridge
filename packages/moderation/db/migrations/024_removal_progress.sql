ALTER TABLE moderation.removals
  ADD COLUMN IF NOT EXISTS verified_through text
    CHECK (verified_through IS NULL OR verified_through ~ '^[0-9a-f]{64}$');
