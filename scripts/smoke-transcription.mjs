import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const appPort = 3100;
const mockPort = 18080;
let receivedMultipart = false;

const mockServer = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ready");
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1");
    receivedMultipart =
      request.method === "POST" &&
      request.url === "/inference" &&
      request.headers["content-type"]?.includes("multipart/form-data") === true &&
      body.includes('name="file"') &&
      body.includes('name="language"') &&
      body.includes("\r\nzh\r\n");
    response.writeHead(receivedMultipart ? 200 : 400, {
      "Content-Type": "application/json"
    });
    response.end(JSON.stringify(
      receivedMultipart
        ? { text: "这是模拟的候选人回答" }
        : { error: "invalid multipart request" }
    ));
  });
});

await new Promise((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

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
    TRANSCRIPTION_PROVIDER: "whisper-cpp",
    WHISPER_CPP_URL: `http://127.0.0.1:${mockPort}/inference`
  },
  stdio: "ignore"
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js smoke server did not start");
}

try {
  await waitForServer();

  const health = await fetch(`http://127.0.0.1:${appPort}/api/health`).then((response) => response.json());
  assert.equal(health.service, "authorized-interview-screen-helper");
  assert.equal(health.status, "ok");
  assert.equal(health.transcriptionProvider, "whisper-cpp");
  assert.equal(health.transcriptionConfigured, true);
  assert.equal(health.transcriptionReady, true);

  const validForm = new FormData();
  validForm.append(
    "audio",
    new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], {
      type: "audio/webm;codecs=opus"
    }),
    "candidate.webm"
  );
  const validResponse = await fetch(`http://127.0.0.1:${appPort}/api/transcribe`, {
    method: "POST",
    body: validForm
  });
  assert.equal(validResponse.status, 200);
  assert.equal((await validResponse.json()).text, "这是模拟的候选人回答");
  assert.equal(receivedMultipart, true);

  const invalidForm = new FormData();
  invalidForm.append(
    "audio",
    new Blob(["not audio"], { type: "audio/webm" }),
    "fake.webm"
  );
  const invalidResponse = await fetch(`http://127.0.0.1:${appPort}/api/transcribe`, {
    method: "POST",
    body: invalidForm
  });
  assert.equal(invalidResponse.status, 415);

  process.stdout.write("transcription smoke test passed\n");
} finally {
  app.kill("SIGTERM");
  await new Promise((resolve) => mockServer.close(resolve));
}
