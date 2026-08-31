-- +goose Up
create table voice_routes (
  id text primary key,
  name text not null,
  mode text not null check (mode in ('cascaded', 'e2e')),
  asr_provider_id text not null default '',
  asr_model_id text not null default '',
  llm_provider_id text not null default '',
  llm_model_id text not null default '',
  tts_provider_id text not null default '',
  tts_model_id text not null default '',
  voice_id text not null default '',
  e2e_provider_id text not null default '',
  e2e_model_id text not null default '',
  active boolean not null default false,
  config_version integer not null default 1 check (config_version >= 1),
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (char_length(name) between 1 and 100)
);

create unique index voice_routes_name_unique on voice_routes (lower(name));
create unique index voice_routes_single_active on voice_routes (active) where active;

insert into voice_routes (
  id, name, mode,
  asr_provider_id, asr_model_id, llm_provider_id, llm_model_id,
  tts_provider_id, tts_model_id, voice_id, e2e_provider_id, e2e_model_id,
  active, config_version, updated_by_user_id, created_at, updated_at
)
select
  'migrated-rtc', '原互动管线', coalesce(pipeline_mode, 'cascaded'),
  coalesce(asr_provider_id, ''), coalesce(asr_model_id, ''),
  coalesce(llm_provider_id, ''), coalesce(llm_model_id, ''),
  coalesce(tts_provider_id, ''), coalesce(tts_model_id, ''), coalesce(tts_voice_id, ''),
  coalesce(e2e_provider_id, ''), coalesce(e2e_model_id, ''),
  case
    when pipeline_mode = 'e2e' then coalesce(e2e_provider_id, '') <> '' and coalesce(e2e_model_id, '') <> ''
    else coalesce(asr_provider_id, '') <> '' and coalesce(asr_model_id, '') <> ''
      and coalesce(llm_provider_id, '') <> '' and coalesce(llm_model_id, '') <> ''
      and coalesce(tts_provider_id, '') <> '' and coalesce(tts_model_id, '') <> ''
  end,
  1, updated_by_user_id, now(), now()
from rtc_configs
where id = 'singleton';

-- +goose Down
drop table if exists voice_routes;
