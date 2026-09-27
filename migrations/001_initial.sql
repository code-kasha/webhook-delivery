CREATE TABLE api_keys (
  id uuid PRIMARY KEY, name text NOT NULL, key_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('admin','publish')),
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE endpoints (
  id uuid PRIMARY KEY, url text NOT NULL, event_types text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true, paused boolean NOT NULL DEFAULT false,
  consecutive_failures integer NOT NULL DEFAULT 0,
  secret text NOT NULL, previous_secret text, previous_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id uuid PRIMARY KEY, type text NOT NULL, idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deliveries (
  id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES events(id),
  endpoint_id uuid NOT NULL REFERENCES endpoints(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','succeeded','failed')),
  attempt_count integer NOT NULL DEFAULT 0, cycle_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at, endpoint_id) WHERE status = 'pending';
CREATE UNIQUE INDEX one_inflight_per_endpoint ON deliveries (endpoint_id) WHERE status = 'in_flight';
CREATE INDEX deliveries_event ON deliveries (event_id);
CREATE INDEX deliveries_endpoint ON deliveries (endpoint_id, created_at);
CREATE TABLE attempts (
  id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries(id),
  number integer NOT NULL, status text NOT NULL CHECK (status IN ('started','succeeded','failed','unknown')),
  response_code integer, duration_ms integer, response_body text, error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (delivery_id, number)
);
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL, target_id uuid NOT NULL, actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
