-- +goose Up
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS discovered_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id text NOT NULL,
  base_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  owned_by text NOT NULL DEFAULT '',
  discovered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (model_id, base_url)
);

ALTER TABLE discovered_models
  ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS capability text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS classified_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS classified_at timestamptz;

UPDATE discovered_models AS dm
SET provider_id = p.id
FROM ai_provider_configs AS p
WHERE dm.provider_id = ''
  AND rtrim(dm.base_url, '/') = rtrim(p.base_url, '/');

UPDATE discovered_models
SET provider_id = 'orphan:' || md5(base_url)
WHERE provider_id = '';

ALTER TABLE discovered_models
  DROP CONSTRAINT IF EXISTS discovered_models_model_id_base_url_key;

ALTER TABLE discovered_models
  ADD CONSTRAINT discovered_models_provider_model_unique UNIQUE (provider_id, model_id);

ALTER TABLE discovered_models
  ADD CONSTRAINT discovered_models_capability_check
    CHECK (capability IN ('llm', 'asr', 'tts', 'e2e', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_discovered_models_provider_id ON discovered_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_discovered_models_capability ON discovered_models(capability);

ALTER TABLE rtc_configs
  ADD COLUMN IF NOT EXISTS pipeline_mode text NOT NULL DEFAULT 'cascaded',
  ADD COLUMN IF NOT EXISTS asr_provider_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asr_model_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS llm_provider_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS llm_model_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tts_provider_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tts_model_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tts_voice_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS e2e_provider_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS e2e_model_id text NOT NULL DEFAULT '';

ALTER TABLE rtc_configs
  ADD CONSTRAINT rtc_configs_pipeline_mode_check
    CHECK (pipeline_mode IN ('cascaded', 'e2e'));

-- +goose Down
ALTER TABLE rtc_configs
  DROP CONSTRAINT IF EXISTS rtc_configs_pipeline_mode_check;

ALTER TABLE rtc_configs
  DROP COLUMN IF EXISTS pipeline_mode,
  DROP COLUMN IF EXISTS asr_provider_id,
  DROP COLUMN IF EXISTS asr_model_id,
  DROP COLUMN IF EXISTS llm_provider_id,
  DROP COLUMN IF EXISTS llm_model_id,
  DROP COLUMN IF EXISTS tts_provider_id,
  DROP COLUMN IF EXISTS tts_model_id,
  DROP COLUMN IF EXISTS tts_voice_id,
  DROP COLUMN IF EXISTS e2e_provider_id,
  DROP COLUMN IF EXISTS e2e_model_id;

ALTER TABLE discovered_models
  DROP CONSTRAINT IF EXISTS discovered_models_capability_check,
  DROP CONSTRAINT IF EXISTS discovered_models_provider_model_unique;

DROP INDEX IF EXISTS idx_discovered_models_capability;
DROP INDEX IF EXISTS idx_discovered_models_provider_id;

ALTER TABLE discovered_models
  ADD CONSTRAINT discovered_models_model_id_base_url_key UNIQUE (model_id, base_url);

ALTER TABLE discovered_models
  DROP COLUMN IF EXISTS classified_at,
  DROP COLUMN IF EXISTS classified_by,
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS capability,
  DROP COLUMN IF EXISTS provider_id;
