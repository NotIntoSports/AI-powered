-- +goose Up
-- Repair: 00012 was rewritten after some databases marked it applied, so those
-- installs are missing speech_configs TTS/ASR columns and pipeline_configs.
-- Idempotent: a fresh database that already ran 00012 is a no-op.

alter table speech_configs
  add column if not exists tts_volume integer,
  add column if not exists tts_speech_rate integer,
  add column if not exists tts_pitch_rate integer,
  add column if not exists tts_sample_rate integer,
  add column if not exists asr_enable_itn boolean not null default true,
  add column if not exists asr_enable_punc boolean not null default true,
  add column if not exists asr_model_name text,
  add column if not exists aliyun_asr_customization_id text,
  add column if not exists aliyun_asr_vocabulary_id text,
  add column if not exists aliyun_asr_enable_itn boolean not null default true,
  add column if not exists aliyun_asr_enable_punc boolean not null default true,
  add column if not exists aliyun_asr_enable_disfluency boolean not null default false,
  add column if not exists aliyun_asr_enable_intermediate boolean not null default true,
  add column if not exists aliyun_asr_enable_semantic_break boolean not null default false,
  add column if not exists aliyun_asr_max_sentence_silence integer not null default 800,
  add column if not exists aliyun_asr_enable_voice_detection boolean not null default false,
  add column if not exists aliyun_asr_max_start_silence integer,
  add column if not exists aliyun_asr_max_end_silence integer;

create table if not exists pipeline_configs (
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
-- Do not drop columns or pipeline_configs: 00012 still owns that schema on
-- databases that applied the current 00012 file.
select 1;
