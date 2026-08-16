-- +goose Up
create table ai_provider_configs (
  id text primary key,
  provider text not null,
  base_url text not null,
  model text not null,
  question_timeout_ms integer not null,
  report_timeout_ms integer not null,
  enabled boolean not null default true,
  encrypted_api_key bytea,
  key_version integer not null default 1,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (char_length(provider) between 1 and 64),
  check (char_length(base_url) between 1 and 500),
  check (char_length(model) between 0 and 200),
  check (question_timeout_ms >= 1000 and question_timeout_ms <= 600000),
  check (report_timeout_ms >= 1000 and report_timeout_ms <= 600000),
  check (config_version >= 1),
  check (key_version >= 1)
);

create table rtc_configs (
  id text primary key,
  app_id text not null,
  language text not null,
  mode text not null check (mode in ('production', 'trial')),
  token_service_url text,
  encrypted_secret bytea,
  trial_expires_at timestamptz,
  trial_room_id text,
  trial_user_id text,
  enabled boolean not null default true,
  key_version integer not null default 1,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (char_length(app_id) between 0 and 200),
  check (char_length(language) between 2 and 20),
  check (token_service_url is null or char_length(token_service_url) between 1 and 500),
  check (trial_room_id is null or trial_room_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  check (trial_user_id is null or trial_user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  check (config_version >= 1),
  check (key_version >= 1)
);

-- +goose Down
drop table rtc_configs;
drop table ai_provider_configs;
