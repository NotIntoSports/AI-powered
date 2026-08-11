import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const workspace = path.resolve(process.argv[2] || ".");
const dataRoot = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(workspace, "data");
let model = null;
const databasePath = path.join(dataRoot, "app.sqlite");
if (existsSync(databasePath)) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    ).get();
    const row = table
      ? database.prepare("SELECT value FROM app_settings WHERE key = 'model'").get()
      : null;
    if (row) model = JSON.parse(row.value);
  } catch { /* report an empty status */ } finally { database.close(); }
}
if (!model) {
  for (const candidate of [
    path.join(dataRoot, "settings", "model.json"),
    path.join(dataRoot, "model.json")
  ]) {
    try { model = JSON.parse(readFileSync(candidate, "utf8")); break; } catch { /* try next */ }
  }
}
process.stdout.write(JSON.stringify({
  model: model ? {
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : "",
    name: typeof model.model === "string" ? model.model : "",
    apiKeyConfigured: typeof model.encryptedApiKey === "string" && model.encryptedApiKey.length > 0
  } : null
}));
