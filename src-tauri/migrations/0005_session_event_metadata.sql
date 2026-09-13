CREATE TABLE session_events_new(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (seq >= 0),
  CHECK (kind IN (
    'status','transcript','reply','takeover',
    'web_sources','turn_meta','scenario'
  )),
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

INSERT INTO session_events_new(
  id, session_id, seq, kind, payload, created_at
)
SELECT
  id, session_id, seq, kind, payload, created_at
FROM session_events;

DROP TABLE session_events;
ALTER TABLE session_events_new RENAME TO session_events;
