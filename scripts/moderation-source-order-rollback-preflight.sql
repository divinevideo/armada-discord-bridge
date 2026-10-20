-- Read-only preflight, NOT a down migration. Stop membership writers first.
-- Any recorded high-water mark makes downgrade unsafe, even when all decisions
-- or evidence have been pruned. Preserve this schema and roll forward instead.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM moderation.member_order_heads)
     OR EXISTS (SELECT 1 FROM moderation.decisions WHERE source_revision IS NOT NULL) THEN
    RAISE EXCEPTION 'Source-order rollback prohibited: retain ledgers, counters and fencing';
  END IF;
END $$;
