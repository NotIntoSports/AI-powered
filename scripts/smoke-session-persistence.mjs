import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const appPort = 3138;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-assistant-session-"));
let app;

function withDatabase(operation, options) {
  const database = new DatabaseSync(path.join(temporaryDirectory, "app.sqlite"), options || {});
  try { return operation(database); } finally { database.close(); }
}

async function waitForApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/session`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("session smoke server did not start");
}

async function startApp() {
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INTERVIEW_DATA_DIR: temporaryDirectory,
      AI_INTERVIEW_OBS_MANAGED: "1",
      AI_INTERVIEW_OBS_PASSWORD: "managed-obs-smoke-password"
    },
    stdio: "ignore",
    windowsHide: true
  });
  await waitForApp();
}

async function stopApp() {
  if (!app || app.killed) return;
  app.kill();
  await new Promise((resolve) => {
    app.once("exit", resolve);
    setTimeout(resolve, 2_000);
  });
}

async function postSession(body) {
  return fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

try {
  await startApp();

  const crossSiteAvatar = await fetch(`http://127.0.0.1:${appPort}/api/avatar`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    body: new FormData()
  });
  assert.equal(crossSiteAvatar.status, 403);
  assert.equal((await crossSiteAvatar.json()).code, "CROSS_SITE_REQUEST");

  const stageUpdate = await fetch(`http://127.0.0.1:${appPort}/api/stage-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${appPort}` },
    body: JSON.stringify({ connected: true, mediaReady: true, ttsSupported: true, voiceCount: 1, ttsState: "ready", ttsError: "", lastSpeechAt: Date.now() })
  });
  assert.equal(stageUpdate.status, 200);
  const stageStatus = await fetch(`http://127.0.0.1:${appPort}/api/stage-status`).then((response) => response.json());
  assert.equal(stageStatus.connected, true);
  assert.equal(stageStatus.ttsState, "ready");

  const avatarBytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  const avatarForm = new FormData();
  avatarForm.append("avatar", new Blob([avatarBytes], { type: "video/webm" }), "assistant.webm");
  const avatarUpload = await fetch(`http://127.0.0.1:${appPort}/api/avatar`, { method: "POST", body: avatarForm });
  assert.equal(avatarUpload.status, 200);
  const avatarMetadata = await avatarUpload.json();
  const avatarRange = await fetch(`http://127.0.0.1:${appPort}/api/avatar/media`, { headers: { Range: "bytes=2-5" } });
  assert.equal(avatarRange.status, 206);
  assert.equal(avatarRange.headers.get("content-range"), `bytes 2-5/${avatarBytes.byteLength}`);
  assert.deepEqual(new Uint8Array(await avatarRange.arrayBuffer()), avatarBytes.slice(2, 6));

  const ttsResponse = await fetch(`http://127.0.0.1:${appPort}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" })
  });
  assert.equal(ttsResponse.status, 422);

  const startedResponse = await postSession({
    action: "start",
    candidateName: "测试用户",
    assistantRole: "interviewer",
    roleName: "前端工程师",
    jobDescription: "React 与性能优化",
    interviewFocus: "工程实践",
    consentConfirmed: true
  });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  assert.equal(started.status, "running");
  assert.equal(started.transcript.length, 1);

  for (const action of [
    { action: "answer", answer: "旧客户端回答", expectedRevision: started.revision },
    { action: "retryQuestion", expectedRevision: started.revision },
    { action: "correctLastAnswer", answer: "旧客户端修正" },
    { action: "generateReport" }
  ]) {
    const response = await postSession(action);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "AGENT_ACTION_REQUIRED");
  }

  const turnPayload = {
    action: "e2e_turn",
    answer: "我负责组件平台。",
    question: "请说明性能优化结果。",
    expectedRevision: started.revision
  };
  const turnResponses = await Promise.all([postSession(turnPayload), postSession(turnPayload)]);
  assert.deepEqual(turnResponses.map((response) => response.status).sort(), [200, 409]);
  const turnResponse = turnResponses.find((response) => response.status === 200);
  assert.equal(turnResponse.status, 200);
  const turn = await turnResponse.json();
  assert.equal(turn.transcript.at(-2).text, "我负责组件平台。");
  assert.equal(turn.transcript.at(-1).text, "请说明性能优化结果。");

  const retryResponse = await postSession({ action: "agentRetryResult", question: "请量化性能优化结果。", expectedRevision: turn.revision });
  assert.equal(retryResponse.status, 200);
  const retried = await retryResponse.json();
  assert.equal(retried.transcript.at(-1).text, "请量化性能优化结果。");

  const correctionResponse = await postSession({
    action: "agentCorrectionResult",
    answer: "我负责组件平台，首屏耗时降低了三成。",
    question: "这个结果如何测量？",
    expectedRevision: retried.revision
  });
  assert.equal(correctionResponse.status, 200);
  const corrected = await correctionResponse.json();
  assert.equal(corrected.transcript.at(-2).text, "我负责组件平台，首屏耗时降低了三成。");
  assert.equal(corrected.transcript.at(-1).text, "这个结果如何测量？");

  assert.equal((await postSession({ action: "finish" })).status, 200);
  const reportResponse = await postSession({
    action: "agentReportResult",
    report: {
      summary: "候选人描述了组件平台和性能优化。",
      evidence: [{ topic: "性能", observation: "给出了量化结果。", quotes: ["首屏耗时降低了三成。"] }],
      strengths: ["能够说明个人职责。"],
      followUps: ["人工核实测量口径。"],
      limitations: ["未提供原始数据。"]
    }
  });
  assert.equal(reportResponse.status, 200);
  const reported = await reportResponse.json();
  assert.equal(reported.report.humanReviewRequired, true);

  const history = await fetch(`http://127.0.0.1:${appPort}/api/sessions`).then((response) => response.json());
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, started.sessionId);
  assert.equal(history[0].reportReady, true);
  const archivedExport = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export`);
  assert.equal(archivedExport.status, 200);
  assert.equal((await archivedExport.json()).sessionId, started.sessionId);
  const archivedMarkdown = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export?format=markdown`);
  assert.equal(archivedMarkdown.status, 200);
  assert.match(archivedMarkdown.headers.get("content-type") || "", /text\/markdown/);

  await stopApp();
  withDatabase((database) => database.prepare(
    "UPDATE current_session SET payload = ? WHERE singleton_id = 1"
  ).run("{ this is not valid interview JSON"));
  await startApp();
  const persisted = await fetch(`http://127.0.0.1:${appPort}/api/session`).then((response) => response.json());
  assert.equal(persisted.sessionId, started.sessionId);
  assert.equal(persisted.status, "finished");
  assert.equal(persisted.report.summary, "候选人描述了组件平台和性能优化。");
  const quarantined = withDatabase((database) => database.prepare(
    "SELECT payload FROM corrupt_records WHERE source = 'current_session' ORDER BY id DESC LIMIT 1"
  ).get(), { readOnly: true });
  assert.equal(quarantined.payload, "{ this is not valid interview JSON");

  const deleteResponse = await fetch(`http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).deleted, true);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/sessions`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export`)).status, 404);
  process.stdout.write("Agent-only session persistence smoke test passed\n");
} finally {
  await stopApp();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
