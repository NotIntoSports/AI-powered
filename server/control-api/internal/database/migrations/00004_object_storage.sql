-- +goose Up
create table object_storage_configs (
  id text primary key,
  provider text not null,
  region text not null,
  bucket text not null,
  secret_id text not null,
  encrypted_secret_key bytea,
  enabled boolean not null default true,
  key_version integer not null default 1,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (provider = 'tencent-cos'),
  check (char_length(region) between 0 and 64),
  check (char_length(bucket) between 0 and 128),
  check (char_length(secret_id) between 0 and 128),
  check (config_version >= 1),
  check (key_version >= 1)
);

create table resumes (
  id text primary key,
  uploaded_by_user_id text not null references users(id) on delete restrict,
  candidate_name text not null,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  object_key text not null unique,
  sha256 text not null,
  created_at timestamptz not null,
  check (char_length(candidate_name) between 0 and 50),
  check (char_length(original_filename) between 1 and 200),
  check (char_length(content_type) between 1 and 128),
  check (size_bytes > 0 and size_bytes <= 10485760),
  check (char_length(object_key) between 1 and 500),
  check (char_length(sha256) = 64)
);

create index resumes_created_at_idx on resumes (created_at desc);

-- +goose Down
drop table resumes;
drop table object_storage_configs;
