-- +goose Up
ALTER TABLE discovered_models
  ADD COLUMN IF NOT EXISTS realtime_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS realtime_verification_status text NOT NULL DEFAULT 'untested',
  ADD COLUMN IF NOT EXISTS realtime_verification_message text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS realtime_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS realtime_verified_provider_version integer NOT NULL DEFAULT 0;

ALTER TABLE discovered_models
  ADD CONSTRAINT discovered_models_realtime_status_check
    CHECK (realtime_verification_status IN ('untested', 'verified', 'failed', 'stale'));

-- +goose Down
ALTER TABLE discovered_models
  DROP CONSTRAINT IF EXISTS discovered_models_realtime_status_check,
  DROP COLUMN IF EXISTS realtime_verified_provider_version,
  DROP COLUMN IF EXISTS realtime_verified_at,
  DROP COLUMN IF EXISTS realtime_verification_message,
  DROP COLUMN IF EXISTS realtime_verification_status,
  DROP COLUMN IF EXISTS realtime_enabled;
