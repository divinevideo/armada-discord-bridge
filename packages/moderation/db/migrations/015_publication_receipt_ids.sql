-- Keep only opaque public-event identities with the durable delivery record.
-- Expiry may erase signed payloads, case plaintext and audit without destroying
-- the ability to verify an already attempted control publication by readback.
ALTER TABLE moderation.deliveries ADD COLUMN IF NOT EXISTS publication_event_ids text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation.deliveries'::regclass AND conname = 'publication_receipt_identity') THEN
    ALTER TABLE moderation.deliveries ADD CONSTRAINT publication_receipt_identity CHECK (
      publication_event_ids IS NULL OR (cardinality(publication_event_ids) = 1 AND publication_event_ids[1] IS NOT NULL AND publication_event_ids[1] ~ '^[0-9a-f]{64}$'));
  END IF;
END $$;
-- This copies an existing outer ID, not a guessed decrypted target or a claim
-- of successful publication. Recovery still verifies fetched signatures/folds.
UPDATE moderation.deliveries d SET publication_event_ids = ARRAY[d.signed_events->0->>'id']
  FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND d.target = 'concord'
    AND c.action IN ('ban_member', 'unban_member') AND d.publication_attempted AND d.publication_event_ids IS NULL
    AND CASE WHEN jsonb_typeof(d.signed_events) = 'array' THEN jsonb_array_length(d.signed_events) = 1 ELSE false END
    AND jsonb_typeof(d.signed_events->0->'id') = 'string' AND (d.signed_events->0->>'id') ~ '^[0-9a-f]{64}$';

-- Old unfenced expiry erased payloads without recording whether a generation
-- existed. Its conservative send marker is not proof that nothing was sent.
-- Keep that unknown outcome blocked; no event ID can be reconstructed in SQL.
UPDATE moderation.deliveries d SET result_code = 'concord_recovery_requires_operator'
  FROM moderation.decisions c WHERE c.decision_id = d.decision_id AND c.source_revision IS NULL
    AND c.action IN ('ban_member', 'unban_member') AND d.target = 'concord' AND d.state = 'failed'
    AND d.result_code = 'decision_expired' AND d.publication_attempted AND d.attempts > 0
    AND d.signed_events IS NULL AND d.publication_event_ids IS NULL;
