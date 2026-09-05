CREATE TABLE materials(
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  retrieval_blocked INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL DEFAULT '',
  chunker_version TEXT NOT NULL DEFAULT '',
  embedding_space_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (byte_size >= 0),
  CHECK (retrieval_blocked IN (0, 1)),
  CHECK (status IN ('importing', 'text_ready', 'vector_ready', 'failed', 'deleting')),
  UNIQUE (content_sha256)
) STRICT;

CREATE TABLE material_documents(
  material_id TEXT PRIMARY KEY,
  extracted_text TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE material_chunks(
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_estimate INTEGER NOT NULL,
  start_char INTEGER NOT NULL,
  end_char INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  embedding_status TEXT NOT NULL,
  embedding_space_id TEXT,
  CHECK (chunk_index >= 0),
  CHECK (size_estimate >= 0),
  CHECK (start_char >= 0),
  CHECK (end_char >= start_char),
  CHECK (embedding_status IN ('pending', 'ready', 'stale', 'skipped', 'failed')),
  UNIQUE (material_id, chunk_index),
  FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
) STRICT;

CREATE VIRTUAL TABLE material_chunks_fts USING fts5(
  content,
  material_id UNINDEXED,
  chunk_id UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE embedding_spaces(
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  distance TEXT NOT NULL,
  normalized INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (dimensions >= 1 AND dimensions <= 65536),
  CHECK (normalized IN (0, 1)),
  CHECK (active IN (0, 1)),
  CHECK (distance IN ('cosine')),
  UNIQUE (fingerprint)
) STRICT;

CREATE TABLE material_file_cleanup(
  id INTEGER PRIMARY KEY,
  stored_path TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL
) STRICT;
