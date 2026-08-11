import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const port = 3141;
const dataRoot = await mkdtemp(path.join(tmpdir(), "ai-interview-migration-"));
const timestamp = new Date().toISOString();
const session = {
  sessionId: "legacy-session",
  revision: 2,
  status: "finished",
  speakingText: "",
  candidateName: "迁移候选人",
  roleName: "测试工程师",
  jobDescription: "",
  interviewFocus: "",
  maxQuestions: 2,
  consentConfirmed: true,
  consentConfirmedAt: timestamp,
  startedAt: timestamp,
  finishedAt: timestamp,
  transcript: [],
  report: null
};
let app;

async function waitForApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("migration smoke server did not start");
}

try {
  await mkdir(path.join(dataRoot, "archive"), { recursive: true });
  await mkdir(path.join(dataRoot, "avatar"), { recursive: true });
  await writeFile(path.join(dataRoot, "current.json"), JSON.stringify(session));
  await writeFile(path.join(dataRoot, "archive", "legacy-session.json"), JSON.stringify(session));
  await writeFile(path.join(dataRoot, "model.json"), JSON.stringify({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "legacy-model",
    encryptedApiKey: null
  }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(dataRoot, "avatar", "media"), png);
  await writeFile(path.join(dataRoot, "avatar", "metadata.json"), JSON.stringify({
    available: true,
    kind: "image",
    mimeType: "image/png",
    originalName: "legacy.png",
    size: png.length,
    version: "legacy-avatar",
    updatedAt: timestamp
  }));

  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, INTERVIEW_DATA_DIR: dataRoot },
    stdio: "ignore",
    windowsHide: true
  });
  await waitForApp();

  const current = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json());
  assert.equal(current.sessionId, "legacy-session");
  const history = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json());
  assert.equal(history[0].sessionId, "legacy-session");
  const model = await fetch(`http://127.0.0.1:${port}/api/settings/model`).then((response) => response.json());
  assert.equal(model.model, "legacy-model");
  const avatar = await fetch(`http://127.0.0.1:${port}/api/avatar`).then((response) => response.json());
  assert.equal(avatar.originalName, "legacy.png");

  const database = new DatabaseSync(path.join(dataRoot, "app.sqlite"), { readOnly: true });
  try {
    const migrations = database.prepare(
      "SELECT key FROM app_settings WHERE key LIKE 'migration:%' ORDER BY key"
    ).all().map((row) => row.key);
    assert.deepEqual(migrations, [
      "migration:avatar-json",
      "migration:interview-json",
      "migration:model-json"
    ]);
  } finally { database.close(); }
} finally {
  if (app && !app.killed) {
    app.kill();
    await new Promise((resolve) => {
      app.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
  }
  await rm(dataRoot, { recursive: true, force: true });
}

process.stdout.write("Legacy JSON to SQLite migration smoke test passed\n");
