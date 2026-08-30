-- +goose Up
CREATE TABLE token_plan_official_models (
  model_id text PRIMARY KEY,
  capability text NOT NULL,
  protocol text NOT NULL,
  source_url text NOT NULL,
  source_updated_at text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE token_plan_catalog_sync (
  id text PRIMARY KEY CHECK (id = 'personal'),
  source_url text NOT NULL,
  source_updated_at text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  warning text NOT NULL DEFAULT ''
);

CREATE TABLE token_plan_model_status (
  provider_id text NOT NULL REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  key_discovered boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'untested',
  verification_message text NOT NULL DEFAULT '',
  verified_at timestamptz,
  PRIMARY KEY (provider_id, model_id)
);

-- +goose Down
DROP TABLE IF EXISTS token_plan_model_status;
DROP TABLE IF EXISTS token_plan_catalog_sync;
DROP TABLE IF EXISTS token_plan_official_models;
