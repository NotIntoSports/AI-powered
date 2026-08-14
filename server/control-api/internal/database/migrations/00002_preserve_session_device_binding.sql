-- +goose Up
alter table user_sessions
  drop constraint user_sessions_device_id_fkey;

alter table user_sessions
  add constraint user_sessions_device_id_fkey
  foreign key (device_id) references devices(id) on delete restrict;

-- +goose Down
alter table user_sessions
  drop constraint user_sessions_device_id_fkey;

alter table user_sessions
  add constraint user_sessions_device_id_fkey
  foreign key (device_id) references devices(id) on delete set null;
