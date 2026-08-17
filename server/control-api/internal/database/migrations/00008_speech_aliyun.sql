-- +goose Up
alter table speech_configs
  add column active_provider text not null default 'volcengine',
  add column aliyun_app_key text not null default '',
  add column aliyun_voice text not null default 'xiaoyun',
  add column aliyun_gateway text not null default 'https://nls-gateway-cn-shanghai.aliyuncs.com',
  add column aliyun_enabled boolean not null default true,
  add column encrypted_aliyun_access_key_id bytea,
  add column encrypted_aliyun_access_key_secret bytea,
  add column encrypted_aliyun_token bytea,
  add constraint speech_configs_active_provider_check check (active_provider in ('volcengine', 'aliyun')),
  add constraint speech_configs_aliyun_app_key_len check (char_length(aliyun_app_key) between 0 and 200),
  add constraint speech_configs_aliyun_voice_len check (char_length(aliyun_voice) between 1 and 64),
  add constraint speech_configs_aliyun_gateway_len check (char_length(aliyun_gateway) between 1 and 500);

-- +goose Down
alter table speech_configs
  drop constraint speech_configs_active_provider_check,
  drop constraint speech_configs_aliyun_app_key_len,
  drop constraint speech_configs_aliyun_voice_len,
  drop constraint speech_configs_aliyun_gateway_len,
  drop column active_provider,
  drop column aliyun_app_key,
  drop column aliyun_voice,
  drop column aliyun_gateway,
  drop column aliyun_enabled,
  drop column encrypted_aliyun_access_key_id,
  drop column encrypted_aliyun_access_key_secret,
  drop column encrypted_aliyun_token;
