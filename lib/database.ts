import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const dataRoot = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data");

export const databasePath = path.join(dataRoot, "app.sqlite");

const globalDatabase = globalThis as typeof globalThis & {
  interviewDatabase?: DatabaseSync;
};

function initializeDatabase() {
  mkdirSync(dataRoot, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS current_session (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS archived_sessions (
      session_id TEXT PRIMARY KEY,
      finished_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS archived_sessions_finished_at
      ON archived_sessions(finished_at DESC);
    CREATE TABLE IF NOT EXISTS avatar_metadata (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS corrupt_records (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run();
  return database;
}

export function getDatabase() {
  globalDatabase.interviewDatabase ??= initializeDatabase();
  return globalDatabase.interviewDatabase;
}

export function getSetting(key: string) {
  const row = getDatabase()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDatabase().prepare(`
    INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

export function deleteSetting(key: string) {
  getDatabase().prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

export function hasMigration(key: string) {
  return getSetting(`migration:${key}`) === "complete";
}

export function markMigrationComplete(key: string) {
  setSetting(`migration:${key}`, "complete");
}

export function runTransaction<T>(operation: () => T): T {
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}
