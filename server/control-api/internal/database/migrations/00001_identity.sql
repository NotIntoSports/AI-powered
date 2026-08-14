-- +goose Up
create type user_role as enum ('admin', 'operator');
create type user_status as enum ('active', 'disabled', 'deleted');

create table users (
  id text primary key,
  username text not null,
  username_normalized text not null unique,
  password_hash text not null,
  role user_role not null,
  status user_status not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_login_at timestamptz
);

create table devices (
  id text primary key,
  user_id text not null references users(id) on delete restrict,
  client_version text not null,
  operating_system text not null,
  os_version text not null,
  last_seen_at timestamptz not null,
  disabled_at timestamptz
);

create table user_sessions (
  id text primary key,
  user_id text not null references users(id) on delete restrict,
  token_digest bytea not null unique check (octet_length(token_digest) = 32),
  purpose text not null check (purpose in ('browser', 'desktop')),
  device_id text references devices(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index user_sessions_user_id_idx on user_sessions (user_id);
create index user_sessions_expires_at_idx on user_sessions (expires_at);
create index devices_user_id_idx on devices (user_id);

create table audit_logs (
  id text primary key,
  actor_user_id text references users(id) on delete restrict,
  action text not null,
  target_type text not null,
  target_id text,
  result text not null,
  request_id text not null,
  source_ip inet,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  check (jsonb_typeof(metadata) = 'object')
);

create index audit_logs_actor_user_id_idx on audit_logs (actor_user_id);
create index audit_logs_created_at_idx on audit_logs (created_at);

create function prevent_audit_log_mutation() returns trigger as $$
begin
  raise exception 'audit logs are immutable';
end;
$$ language plpgsql;

create trigger audit_logs_immutable
before update or delete on audit_logs
for each row execute function prevent_audit_log_mutation();

-- +goose Down
drop table audit_logs;
drop function prevent_audit_log_mutation();
drop table user_sessions;
drop table devices;
drop table users;
drop type user_status;
drop type user_role;
