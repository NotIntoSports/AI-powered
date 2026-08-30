-- +goose Up
alter table rtc_configs
  drop constraint if exists rtc_configs_active_provider_check,
  drop column if exists active_provider,
  drop column if exists app_id,
  drop column if exists mode,
  drop column if exists token_service_url,
  drop column if exists encrypted_secret,
  drop column if exists trial_expires_at,
  drop column if exists trial_room_id,
  drop column if exists trial_user_id,
  drop column if exists key_version;

-- +goose Down
alter table rtc_configs
  add column app_id text not null default '',
  add column mode text not null default 'production',
  add column token_service_url text,
  add column encrypted_secret bytea,
  add column trial_expires_at timestamptz,
  add column trial_room_id text,
  add column trial_user_id text,
  add column key_version integer not null default 1,
  add column active_provider text not null default 'livekit';
