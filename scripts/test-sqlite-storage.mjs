import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-interview-sqlite-"));
const secret = "obs-plaintext-must-not-be-stored";
try {
  const protectedValue = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.resolve("scripts/dpapi-secret.ps1"), "-Mode", "Protect"
  ], { input: secret, encoding: "utf8", windowsHide: true });
  assert.equal(protectedValue.status, 0);
  assert.equal(protectedValue.stdout.includes(secret), false);

  const environment = { ...process.env, INTERVIEW_DATA_DIR: temporaryDirectory };
  const saved = spawnSync(process.execPath, [
    "scripts/obs-secret-store.mjs", "set", process.cwd()
  ], { input: protectedValue.stdout, encoding: "utf8", env: environment, windowsHide: true });
  assert.equal(saved.status, 0, saved.stderr);

  const loaded = spawnSync(process.execPath, [
    "scripts/obs-secret-store.mjs", "get", process.cwd()
  ], { encoding: "utf8", env: environment, windowsHide: true });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, protectedValue.stdout);

  const databasePath = path.join(temporaryDirectory, "app.sqlite");
  assert.equal((await readFile(databasePath)).includes(Buffer.from(secret)), false);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT value FROM app_settings WHERE key = 'obs_websocket_password'"
    ).get();
    assert.equal(row.value, protectedValue.stdout);
  } finally { database.close(); }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("SQLite encrypted OBS storage test passed\n");
