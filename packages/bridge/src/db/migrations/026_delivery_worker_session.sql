-- Existing lifecycles may already have accepted work without a crash marker.
-- Treat them as uncertain; newly created lifecycles explicitly start clean.
ALTER TABLE channel_delivery_lifecycles
  ADD COLUMN worker_uncertain boolean NOT NULL DEFAULT true,
  ADD COLUMN worker_session uuid;
