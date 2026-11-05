-- A session retry is idempotent only under the same fenced lease.
ALTER TABLE channel_delivery_lifecycles
  ADD COLUMN worker_lease_holder uuid,
  ADD COLUMN worker_lease_token bigint;
