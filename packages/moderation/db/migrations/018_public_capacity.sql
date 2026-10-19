CREATE TABLE IF NOT EXISTS moderation.public_capacity_state (
  org_id text NOT NULL, community_id text NOT NULL CHECK (community_id ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('normal','warning','paused','unknown')),
  contract_hash text CHECK (contract_hash ~ '^[0-9a-f]{64}$'), paused_at timestamptz,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  history_count bigint NOT NULL CHECK (history_count >= 0), history_bytes bigint NOT NULL CHECK (history_bytes >= 0),
  rekey_count bigint NOT NULL CHECK (rekey_count >= 0), stream_count bigint NOT NULL CHECK (stream_count >= 0),
  in_flight bigint NOT NULL CHECK (in_flight >= 0), gate_elapsed_ms double precision CHECK (gate_elapsed_ms >= 0),
  observed_at timestamptz NOT NULL, resumed_by text,
  PRIMARY KEY (org_id, community_id)
);
-- Replayed001 grants must never turn a validator/read API into a latch writer.
REVOKE ALL ON moderation.public_capacity_state FROM PUBLIC, moderation_validator, moderation_reports, moderation_api, moderation_operator;
GRANT SELECT ON moderation.public_capacity_state TO moderation_validator, moderation_api;
GRANT SELECT, INSERT, UPDATE ON moderation.public_capacity_state TO moderation_operator;
