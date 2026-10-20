-- Audit erasure (017) relies on the closure time and deadline stored on the
-- row. Enforce what the application already does: a new closure records the
-- current time, and its deadline is at least closure plus the retention
-- snapshot, so the stored deadline always reflects retention policy.
CREATE OR REPLACE FUNCTION moderation.protect_lifecycle_closure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.lifecycle_closed_at IS NULL AND NEW.lifecycle_closed_at IS NOT NULL
    AND (NEW.lifecycle_closed_at < transaction_timestamp() OR NEW.lifecycle_closed_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'Lifecycle closure must record the current time';
  END IF;
  -- Every closure carries its deadline. A closure recorded before this guard
  -- may lack one, and 017's no-shorten rule only covers an existing deadline,
  -- so a deadline written later is held to the same arithmetic.
  IF NEW.lifecycle_closed_at IS NOT NULL
    AND ((OLD.lifecycle_closed_at IS NULL) OR NEW.audit_delete_after IS DISTINCT FROM OLD.audit_delete_after)
    AND (NEW.audit_retention_seconds IS NULL OR NEW.audit_delete_after IS NULL
      OR NEW.audit_delete_after < NEW.lifecycle_closed_at + NEW.audit_retention_seconds * interval '1 second') THEN
    RAISE EXCEPTION 'Lifecycle closure must keep audit for its retention';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_lifecycle_closure ON moderation.decisions;
CREATE TRIGGER protect_lifecycle_closure BEFORE UPDATE ON moderation.decisions
  FOR EACH ROW EXECUTE FUNCTION moderation.protect_lifecycle_closure();
REVOKE ALL ON FUNCTION moderation.protect_lifecycle_closure() FROM PUBLIC;

-- Only the worker's operator connection erases audit (runtime.ts); the API
-- closes and reopens lifecycles but never writes audit. 017 re-grants the
-- column on every boot, so this narrowing must run after it, every time.
REVOKE UPDATE (audit) ON moderation.decisions FROM moderation_api;
