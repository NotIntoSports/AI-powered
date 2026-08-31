-- +goose Up
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
    when coalesce(pipeline_mode, 'cascaded') = 'e2e' then coalesce(e2e_provider_id, '') <> '' and coalesce(e2e_model_id, '') <> ''
    else coalesce(asr_provider_id, '') <> '' and coalesce(asr_model_id, '') <> ''
      and coalesce(llm_provider_id, '') <> '' and coalesce(llm_model_id, '') <> ''
      and coalesce(tts_provider_id, '') <> '' and coalesce(tts_model_id, '') <> ''
  end,
  1, updated_by_user_id, now(), now()
from rtc_configs
where not exists (select 1 from voice_routes)
order by case when id in ('default', 'singleton') then 0 else 1 end, updated_at desc
limit 1;

-- +goose Down
delete from voice_routes where id = 'migrated-rtc' and not exists (
  select 1 from rtc_configs where id = 'singleton'
);
