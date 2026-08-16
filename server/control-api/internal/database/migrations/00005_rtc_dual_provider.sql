-- +goose Up
alter table rtc_configs
  add column active_provider text not null default 'volcengine',
  add column livekit_url text,
  add column livekit_api_key text,
  add column encrypted_livekit_api_secret bytea,
  add column livekit_asr_base_url text,
  add column livekit_asr_model text,
  add column encrypted_asr_api_key bytea,
  add column livekit_key_version integer not null default 1,
  add constraint rtc_configs_active_provider_check check (active_provider in ('volcengine', 'livekit')),
  add constraint rtc_configs_livekit_url_len check (livekit_url is null or char_length(livekit_url) between 1 and 500),
  add constraint rtc_configs_livekit_api_key_len check (livekit_api_key is null or char_length(livekit_api_key) between 1 and 200),
  add constraint rtc_configs_livekit_asr_url_len check (livekit_asr_base_url is null or char_length(livekit_asr_base_url) between 1 and 500),
  add constraint rtc_configs_livekit_asr_model_len check (livekit_asr_model is null or char_length(livekit_asr_model) between 1 and 200),
  add constraint rtc_configs_livekit_key_version_min check (livekit_key_version >= 1);

-- +goose Down
alter table rtc_configs
  drop constraint rtc_configs_active_provider_check,
  drop constraint rtc_configs_livekit_url_len,
  drop constraint rtc_configs_livekit_api_key_len,
  drop constraint rtc_configs_livekit_asr_url_len,
  drop constraint rtc_configs_livekit_asr_model_len,
  drop constraint rtc_configs_livekit_key_version_min,
  drop column active_provider,
  drop column livekit_url,
  drop column livekit_api_key,
  drop column encrypted_livekit_api_secret,
  drop column livekit_asr_base_url,
  drop column livekit_asr_model,
  drop column encrypted_asr_api_key,
  drop column livekit_key_version;
