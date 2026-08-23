-- +goose Up
alter table user_speech_voices
  add column allocation_status text not null default 'unallocated',
  add column allocation_token text,
  add column allocation_started_at timestamptz;

update user_speech_voices
set allocation_status = 'allocated'
where char_length(trim(speaker_id)) > 0;

alter table user_speech_voices
  add constraint user_speech_voices_allocation_status_check
    check (allocation_status in ('unallocated', 'allocating', 'allocated')),
  add constraint user_speech_voices_allocation_shape_check
    check (
      (allocation_status = 'unallocated' and speaker_id = '' and allocation_token is null and allocation_started_at is null)
      or (allocation_status = 'allocating' and speaker_id = '' and allocation_token is not null and allocation_started_at is not null)
      or (allocation_status = 'allocated' and char_length(trim(speaker_id)) > 0 and allocation_token is null and allocation_started_at is null)
    );

-- +goose Down
alter table user_speech_voices
  drop constraint user_speech_voices_allocation_shape_check,
  drop constraint user_speech_voices_allocation_status_check,
  drop column allocation_started_at,
  drop column allocation_token,
  drop column allocation_status;
