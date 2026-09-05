import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README and CI document only the Tauri product path", async () => {
  const readme = await readFile("README.md", "utf8");
  const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(readme, /npm install/);
  assert.match(readme, /npm run tauri:dev/);
  assert.match(readme, /npm run tauri:build/);
  assert.match(readme, /npm run test:tauri/);
  assert.match(readme, /npm run test:tauri-package/);
  assert.doesNotMatch(readme, /npm run dev\b/);
  assert.doesNotMatch(readme, /First-Time-Setup|Start-AI-Virtual-Assistant|Check-AI-Virtual-Assistant/);
  assert.doesNotMatch(readme, /Electron 主进程|npm run start:windows|\/stage/);
  assert.match(readme, /托管 OBS[\s\S]*已延期|managed OBS[\s\S]*deferred/i);

  assert.doesNotMatch(notices, /Electron|electron-builder|Next\.js|obs-websocket-js|vad-web|@volcengine\/rtc|livekit-agents|\bchi\b|\bpgx\b|\bgoose\b/);
  assert.match(notices, /Tauri/);
  assert.match(notices, /React/);
  assert.match(notices, /livekit-client/);

  assert.match(ci, /dtolnay\/rust-toolchain|actions-rust-lang\/setup-rust-toolchain/);
  assert.match(ci, /npm run test:tauri/);
  assert.match(ci, /1\.96/);
  assert.doesNotMatch(ci, /electron|control-api|livekit-agent|postgres|nginx/i);
});
