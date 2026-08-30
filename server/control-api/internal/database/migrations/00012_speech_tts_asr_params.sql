-- +goose Up
alter table speech_configs
  add column tts_volume integer,
  add column tts_speech_rate integer,
  add column tts_pitch_rate integer,
  add column tts_sample_rate integer,
  add column asr_enable_itn boolean not null default true,
  add column asr_enable_punc boolean not null default true,
  add column asr_model_name text,
  add column aliyun_asr_customization_id text,
  add column aliyun_asr_vocabulary_id text,
  add column aliyun_asr_enable_itn boolean not null default true,
  add column aliyun_asr_enable_punc boolean not null default true,
  add column aliyun_asr_enable_disfluency boolean not null default false,
  add column aliyun_asr_enable_intermediate boolean not null default true,
  add column aliyun_asr_enable_semantic_break boolean not null default false,
  add column aliyun_asr_max_sentence_silence integer not null default 800,
  add column aliyun_asr_enable_voice_detection boolean not null default false,
  add column aliyun_asr_max_start_silence integer,
  add column aliyun_asr_max_end_silence integer;

create table pipeline_configs (
  id text primary key,
  mode text not null default 'cascaded' check (mode in ('cascaded', 'e2e')),
  e2e_provider text not null default 'tokenplan',
  cascaded_asr text not null default 'livekit-agent',
  cascaded_tts text not null default 'speech:aliyun' check (cascaded_tts in ('speech:aliyun', 'speech:volcengine')),
  enabled boolean not null default true,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (config_version >= 1)
);

-- +goose Down
drop table pipeline_configs;

alter table speech_configs
  drop column if exists tts_volume,
  drop column if exists tts_speech_rate,
  drop column if exists tts_pitch_rate,
  drop column if exists tts_sample_rate,
  drop column if exists asr_enable_itn,
  drop column if exists asr_enable_punc,
  drop column if exists asr_model_name,
  drop column if exists aliyun_asr_customization_id,
  drop column if exists aliyun_asr_vocabulary_id,
  drop column if exists aliyun_asr_enable_itn,
  drop column if exists aliyun_asr_enable_punc,
  drop column if exists aliyun_asr_enable_disfluency,
  drop column if exists aliyun_asr_enable_intermediate,
  drop column if exists aliyun_asr_enable_semantic_break,
  drop column if exists aliyun_asr_max_sentence_silence,
  drop column if exists aliyun_asr_enable_voice_detection,
  drop column if exists aliyun_asr_max_start_silence,
  drop column if exists aliyun_asr_max_end_silence;
