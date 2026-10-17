-- A newer ban or unban for a member supersedes an older one's unsent
-- deliveries. The outbox marks them failed with superseded_by_newer_decision
-- and records here which decision took over; the older decision itself stays
-- on record. Existing rows stay NULL: nothing was superseded before this.
-- Not API-writable: 011's column grants do not cover it.
ALTER TABLE moderation.deliveries
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES moderation.decisions ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS decisions_member_order ON moderation.decisions (community_id, author, created_at, decision_id)
  WHERE action IN ('ban_member', 'unban_member');
-- Acceptance inserts only a queued target. Worker-owned outcome metadata,
-- including supersession, is not supplied by the API on insertion either.
REVOKE INSERT ON moderation.deliveries FROM moderation_api;
GRANT INSERT (decision_id, target) ON moderation.deliveries TO moderation_api;
