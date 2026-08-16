-- +goose Up
create extension if not exists vector with schema public;

create table knowledge_chunks (
  id bigserial primary key,
  source_type text not null,
  source_id text not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(1024),
  embedding_model text not null,
  candidate_name text not null default '',
  created_at timestamptz not null,
  check (source_type in ('resume', 'knowledge')),
  check (chunk_index >= 0),
  check (char_length(content) between 1 and 8000),
  check (char_length(embedding_model) between 1 and 200)
);

create index knowledge_chunks_source_idx
  on knowledge_chunks (source_type, source_id);
create index knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

alter table resumes
  add column index_status text not null default 'pending',
  add column index_error text,
  add column indexed_at timestamptz,
  add column knowledge_provider text not null default 'local-pgvector',
  add column external_doc_id text;
alter table resumes
  add constraint resumes_index_status_check
    check (index_status in ('pending', 'indexing', 'ready', 'failed', 'skipped'));
alter table resumes
  add constraint resumes_knowledge_provider_check
    check (char_length(knowledge_provider) between 1 and 64);

-- +goose Down
alter table resumes drop constraint if exists resumes_index_status_check;
alter table resumes drop constraint if exists resumes_knowledge_provider_check;
alter table resumes
  drop column if exists index_status,
  drop column if exists index_error,
  drop column if exists indexed_at,
  drop column if exists knowledge_provider,
  drop column if exists external_doc_id;
drop index if exists knowledge_chunks_embedding_idx;
drop index if exists knowledge_chunks_source_idx;
drop table if exists knowledge_chunks;
