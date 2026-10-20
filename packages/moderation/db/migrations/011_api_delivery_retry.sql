-- Accepted decisions and persisted publication generations are not API-editable.
-- Retry only reschedules delivery; it must not rewrite uncertain signed bytes
-- or erase the record that publication was attempted. Reapply after 008 on boot.
REVOKE UPDATE, DELETE ON moderation.decisions, moderation.deliveries FROM moderation_api;
GRANT SELECT, INSERT ON moderation.decisions, moderation.deliveries TO moderation_api;
GRANT UPDATE (state, available_at, token, lease_until, updated_at) ON moderation.deliveries TO moderation_api;
