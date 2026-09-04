CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_preferences(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE diagnostic_events(
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  area TEXT NOT NULL,
  code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
