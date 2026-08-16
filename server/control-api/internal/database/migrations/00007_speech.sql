-- +goose Up
create table speech_configs (
  id text primary key,
  app_id text not null default '',
  speaker_id text not null default '',
  tts_resource_id text not null default 'seed-icl-2.0',
  asr_resource_id text not null default 'volc.bigasr.auc_turbo',
  enabled boolean not null default true,
  encrypted_api_key bytea,
  encrypted_access_token bytea,
  encrypted_secret_key bytea,
  key_version integer not null default 1,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (char_length(app_id) between 0 and 200),
  check (char_length(speaker_id) between 0 and 256),
  check (char_length(tts_resource_id) between 1 and 128),
  check (char_length(asr_resource_id) between 1 and 128),
  check (config_version >= 1),
  check (key_version >= 1)
);

-- +goose Down
drop table speech_configs;
