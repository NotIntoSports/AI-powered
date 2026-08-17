-- +goose Up
create table user_speech_voices (
  user_id text primary key references users(id) on delete cascade,
  speaker_id text not null default '',
  updated_at timestamptz not null,
  check (char_length(speaker_id) between 0 and 256)
);

-- +goose Down
drop table user_speech_voices;
