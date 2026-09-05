CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  role_profile_id TEXT NOT NULL DEFAULT '',
  voice_route_id TEXT NOT NULL DEFAULT '',
  transport_mode TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status IN (
    'idle','preparing','listening','thinking','speaking',
    'stopping','completed','recovering','blocked','failed','interrupted'
  )),
  CHECK (transport_mode IN ('direct'))
) STRICT;

CREATE TABLE session_turns(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  materials_used INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (turn_index >= 0),
  CHECK (materials_used IN (0, 1)),
  UNIQUE (session_id, turn_index),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE session_citations(
  id INTEGER PRIMARY KEY,
  turn_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  snippet TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE session_events(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (seq >= 0),
  CHECK (kind IN ('status','transcript','reply','takeover')),
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE runtime_snapshots(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  provider_ids TEXT NOT NULL,
  model_ids TEXT NOT NULL,
  voice_route_id TEXT NOT NULL,
  transport_mode TEXT NOT NULL,
  role_hash TEXT NOT NULL,
  knowledge_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (transport_mode IN ('direct')),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
