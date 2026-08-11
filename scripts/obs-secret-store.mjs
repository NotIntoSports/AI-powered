import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [mode, workspace] = process.argv.slice(2);
if (!["get", "set"].includes(mode) || !workspace) process.exit(2);

const dataRoot = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(path.resolve(workspace), "data");
mkdirSync(dataRoot, { recursive: true });
const database = new DatabaseSync(path.join(dataRoot, "app.sqlite"));
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT
`);

try {
  if (mode === "get") {
    const row = database.prepare(
      "SELECT value FROM app_settings WHERE key = 'obs_websocket_password'"
    ).get();
    if (row) process.stdout.write(row.value);
  } else {
    const value = readFileSync(0, "utf8").trim();
    if (!value) process.exit(3);
    database.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('obs_websocket_password', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(value, new Date().toISOString());
  }
} finally {
  database.close();
}
