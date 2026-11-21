ALTER TABLE flow_schedules
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN arrived_disabled boolean NOT NULL DEFAULT false;

-- a webhook the reconcile creates has no token until it is first enabled
ALTER TABLE flow_webhooks
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN arrived_disabled boolean NOT NULL DEFAULT false,
  ALTER COLUMN token_hash DROP NOT NULL,
  ALTER COLUMN token_hint DROP NOT NULL;
