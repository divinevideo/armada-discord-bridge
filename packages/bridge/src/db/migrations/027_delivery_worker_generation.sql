-- A reused session UUID must not revive a view invalidated by pause/resume.
ALTER TABLE channel_delivery_lifecycles ADD COLUMN worker_generation bigint NOT NULL DEFAULT 0;
