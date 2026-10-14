ALTER TABLE moderation.streams ADD COLUMN IF NOT EXISTS retired_at bigint CHECK (retired_at >= 0);
