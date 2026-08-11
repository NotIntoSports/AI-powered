import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const appPort = 3101;
const nextBin = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);
const app = spawn(process.execPath, [nextBin, "start", "-p", String(appPort)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TRANSCRIPTION_PROVIDER: "openai",
    TRANSCRIPTION_BASE_URL: "http://speech.example.com/v1",
    TRANSCRIPTION_API_KEY: "must-never-be-sent"
  },
  stdio: "ignore"
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      const body = await response.json();
      if (
        response.ok &&
        body.service === "authorized-interview-screen-helper" &&
        body.status === "ok"
      ) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js security smoke server did not start");
}

try {
  await waitForServer();
  const health = await fetch(
    `http://127.0.0.1:${appPort}/api/health`
  ).then((response) => response.json());
  assert.equal(health.transcriptionConfigured, false);

  const form = new FormData();
  form.append(
    "audio",
    new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], {
      type: "audio/webm;codecs=opus"
    }),
    "candidate.webm"
  );
  const response = await fetch(`http://127.0.0.1:${appPort}/api/transcribe`, {
    method: "POST",
    body: form
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "INSECURE_TRANSCRIPTION_ENDPOINT");
  assert.match(body.message, /HTTPS/);

  process.stdout.write("transcription security route smoke test passed\n");
} finally {
  app.kill("SIGTERM");
}
