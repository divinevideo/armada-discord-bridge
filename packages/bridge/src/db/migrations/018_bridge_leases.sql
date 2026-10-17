CREATE TABLE bridge_leases (
  resource text PRIMARY KEY,
  holder uuid NOT NULL,
  token bigint NOT NULL CHECK (token > 0),
  expires_at timestamptz NOT NULL
);
