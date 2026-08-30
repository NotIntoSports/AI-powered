-- +goose Up
ALTER TABLE ai_provider_configs
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'OpenAI 兼容',
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

UPDATE ai_provider_configs
SET is_default = true
WHERE id = 'default';

UPDATE ai_provider_configs
SET is_default = true
WHERE NOT EXISTS (SELECT 1 FROM ai_provider_configs WHERE is_default = true)
  AND id = (SELECT id FROM ai_provider_configs ORDER BY updated_at DESC LIMIT 1);

-- +goose Down
ALTER TABLE ai_provider_configs
  DROP COLUMN IF EXISTS is_default,
  DROP COLUMN IF EXISTS name;
