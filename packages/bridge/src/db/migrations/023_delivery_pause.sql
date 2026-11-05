-- A pause revokes workers in every replica without discarding the lifecycle.
ALTER TABLE channel_delivery_lifecycles ADD COLUMN suspended boolean NOT NULL DEFAULT false;
