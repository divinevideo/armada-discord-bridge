-- Existing lifecycle provenance may have been erased by an intermediate rollout.
-- Zero preserves its possible current-life obligations; only newly minted
-- lifecycles can establish a reliable carrier applicability boundary.
ALTER TABLE channel_delivery_lifecycles ADD COLUMN deletion_floor bigint NOT NULL DEFAULT 0;
