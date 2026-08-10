import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const appPort = 3138;
const modelPort = 3139;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-interview-session-"));
let app;
let lastModelAuthorization;
let lastModelPayload;
let modelRequestCount = 0;
let rejectReasoningOnce = false;
let failNextChat = false;
let questionResponseQueue = [];
let delayNextChatMs = 0;

const modelServer = createServer(async (request, response) => {
  if (request.url === "/v1/models" && request.method === "GET") {
    lastModelAuthorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [
        { id: "test-model", object: "model" },
        { id: "local-no-key-model", object: "model" }
      ]
    }));
    return;
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    lastModelAuthorization = request.headers.authorization;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    lastModelPayload = payload;
    modelRequestCount += 1;
    if (delayNextChatMs > 0) {
      const delay = delayNextChatMs;
      delayNextChatMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (failNextChat) {
      failNextChat = false;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temporary model failure" } }));
      return;
    }
    if (rejectReasoningOnce && payload.reasoning_effort) {
      rejectReasoningOnce = false;
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unsupported reasoning_effort" } }));
      return;
    }
    const systemPrompt = String(payload.messages?.[0]?.content || "");
    const content = systemPrompt.includes("面试记录整理助手")
      ? JSON.stringify({
          summary: "候选人描述了组件架构和性能优化经历。",
          evidence: [{
            topic: "性能优化",
            observation: "候选人给出了量化结果。",
            quotes: ["我把首屏时间降低了百分之三十。", "这是一条不存在的引文"]
          }],
          strengths: ["能描述个人负责范围和量化结果。"],
          followUps: ["人工核实性能指标的测量口径。"],
          limitations: ["没有提供项目规模。"]
        })
      : questionResponseQueue.shift() ||
        "<think>这段内部推理绝不能播报。</think>\n### 问题\n- 请具体说明你在这个项目中负责的部分？\n- 第二个问题不应出现？";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content } }]
    }));
    return;
  }
  response.writeHead(404).end();
});

async function waitForApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/session`);
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
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
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      OPENAI_MODEL: "test-model",
      MODEL_QUESTION_TIMEOUT_MS: "1000",
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

try {
  await new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve));
  await startApp();

  const crossSiteAvatarResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/avatar`,
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site"
      },
      body: new FormData()
    }
  );
  assert.equal(crossSiteAvatarResponse.status, 403);
  assert.equal((await crossSiteAvatarResponse.json()).code, "CROSS_SITE_REQUEST");
  const crossSiteTranscriptionResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/transcribe`,
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site"
      },
      body: new FormData()
    }
  );
  assert.equal(crossSiteTranscriptionResponse.status, 403);

  const obsRuntimeResponse = await fetch(`http://127.0.0.1:${appPort}/api/obs/runtime`);
  assert.equal(obsRuntimeResponse.status, 200);
  assert.match(obsRuntimeResponse.headers.get("cache-control") || "", /no-store/);
  const obsRuntime = await obsRuntimeResponse.json();
  assert.deepEqual(obsRuntime, {
    managed: true,
    url: "ws://127.0.0.1:4455",
    password: "managed-obs-smoke-password",
    stageUrl: ""
  });

  const stageStatusUpdateResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-status`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${appPort}`,
        "Sec-Fetch-Site": "same-origin"
      },
      body: JSON.stringify({
        ttsSupported: true,
        voiceCount: 3,
        ttsState: "ready",
        ttsError: "",
        lastSpeechAt: 123456789,
        mediaReady: true
      })
    }
  );
  assert.equal(stageStatusUpdateResponse.status, 200);
  const reportedStageStatus = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-status`
  ).then((response) => response.json());
  assert.equal(reportedStageStatus.connected, true);
  assert.equal(reportedStageStatus.ttsState, "ready");
  assert.equal(reportedStageStatus.lastSpeechAt, 123456789);

  const invalidStageStatusResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ttsSupported: true,
        voiceCount: 3,
        ttsState: "failed",
        ttsError: "",
        lastSpeechAt: 0,
        mediaReady: true
      })
    }
  );
  assert.equal(invalidStageStatusResponse.status, 422);

  const invalidStageTestSpeechResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-test-speech`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" })
    }
  );
  assert.equal(invalidStageTestSpeechResponse.status, 422);
  const stageTestSpeechResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-test-speech`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "这是开始面试前的独立线路测试。" })
    }
  );
  assert.equal(stageTestSpeechResponse.status, 200);
  const queuedStageTestSpeech = await stageTestSpeechResponse.json();
  assert.equal(queuedStageTestSpeech.text, "这是开始面试前的独立线路测试。");
  assert.ok(queuedStageTestSpeech.id > 0);
  assert.ok(queuedStageTestSpeech.createdAt > 0);
  const fetchedStageTestSpeech = await fetch(
    `http://127.0.0.1:${appPort}/api/stage-test-speech`
  ).then((response) => response.json());
  assert.deepEqual(fetchedStageTestSpeech, queuedStageTestSpeech);
  const sessionBeforeTestSpeech = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionBeforeTestSpeech.status, "idle");
  assert.deepEqual(sessionBeforeTestSpeech.transcript, []);

  const ttsResponse = await fetch(`http://127.0.0.1:${appPort}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "你好，这是本机语音测试。" })
  });
  assert.equal(ttsResponse.status, 200);
  assert.equal(ttsResponse.headers.get("content-type"), "audio/wav");
  const ttsBytes = new Uint8Array(await ttsResponse.arrayBuffer());
  assert.ok(ttsBytes.byteLength > 1_000);
  assert.equal(Buffer.from(ttsBytes.slice(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(ttsBytes.slice(8, 12)).toString("ascii"), "WAVE");
  const parallelTtsResponses = await Promise.all([
    fetch(`http://127.0.0.1:${appPort}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "第一条并发语音。" })
    }),
    fetch(`http://127.0.0.1:${appPort}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "第二条并发语音。" })
    })
  ]);
  for (const response of parallelTtsResponses) {
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(Buffer.from(bytes.slice(0, 4)).toString("ascii"), "RIFF");
  }
  const invalidTtsResponse = await fetch(`http://127.0.0.1:${appPort}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" })
  });
  assert.equal(invalidTtsResponse.status, 422);

  const avatarBytes = Uint8Array.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x01, 0x42, 0x86,
    0x81, 0x01, 0x42, 0xf7
  ]);
  const avatarForm = new FormData();
  avatarForm.append(
    "avatar",
    new Blob([avatarBytes], { type: "video/webm" }),
    "interviewer.webm"
  );
  const avatarUploadResponse = await fetch(`http://127.0.0.1:${appPort}/api/avatar`, {
    method: "POST",
    body: avatarForm
  });
  assert.equal(avatarUploadResponse.status, 200);
  const avatarMetadata = await avatarUploadResponse.json();
  assert.equal(avatarMetadata.kind, "video");
  assert.equal(avatarMetadata.size, avatarBytes.byteLength);

  const avatarHeadResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/avatar/media?v=${avatarMetadata.version}`,
    { method: "HEAD" }
  );
  assert.equal(avatarHeadResponse.status, 200);
  assert.equal(avatarHeadResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(Number(avatarHeadResponse.headers.get("content-length")), avatarBytes.byteLength);

  async function assertAvatarRange(range, expectedStart, expectedEnd) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/avatar/media`, {
      headers: { Range: range }
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${expectedStart}-${expectedEnd}/${avatarBytes.byteLength}`
    );
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      avatarBytes.slice(expectedStart, expectedEnd + 1)
    );
  }

  await assertAvatarRange("bytes=4-7", 4, 7);
  await assertAvatarRange("bytes=8-", 8, 11);
  await assertAvatarRange("bytes=-4", 8, 11);
  await assertAvatarRange("bytes=8-999", 8, 11);
  const invalidAvatarRange = await fetch(
    `http://127.0.0.1:${appPort}/api/avatar/media`,
    { headers: { Range: "bytes=-0" } }
  );
  assert.equal(invalidAvatarRange.status, 416);
  assert.equal(
    invalidAvatarRange.headers.get("content-range"),
    `bytes */${avatarBytes.byteLength}`
  );

  const vadModelResponse = await fetch(`http://127.0.0.1:${appPort}/vendor/vad/silero_vad_v5.onnx`);
  assert.equal(vadModelResponse.status, 200);
  assert.ok((await vadModelResponse.arrayBuffer()).byteLength > 2_000_000);
  const vadWasmResponse = await fetch(`http://127.0.0.1:${appPort}/vendor/vad/ort-wasm-simd-threaded.wasm`);
  assert.equal(vadWasmResponse.status, 200);
  assert.ok((await vadWasmResponse.arrayBuffer()).byteLength > 10_000_000);

  const missingConsentResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "start",
      candidateName: "未确认候选人",
      roleName: "前端工程师",
      consentConfirmed: false
    })
  });
  assert.equal(missingConsentResponse.status, 422);

  const startResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "start",
      candidateName: "测试候选人",
      roleName: "前端工程师",
      jobDescription: "负责 Web 性能和组件架构",
      interviewFocus: "个人贡献",
      maxQuestions: 3,
      consentConfirmed: true
    })
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.status, "running");
  assert.ok(started.sessionId);
  assert.equal(started.transcript.length, 1);
  assert.equal(started.maxQuestions, 3);
  assert.equal(started.jobDescription, "负责 Web 性能和组件架构");
  const overwriteRunningSessionResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        candidateName: "不应覆盖",
        roleName: "其他岗位",
        jobDescription: "",
        interviewFocus: "",
        maxQuestions: 2,
        consentConfirmed: true
      })
    }
  );
  assert.equal(overwriteRunningSessionResponse.status, 409);
  const sessionAfterRejectedOverwrite = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionAfterRejectedOverwrite.sessionId, started.sessionId);
  assert.equal(sessionAfterRejectedOverwrite.candidateName, "测试候选人");
  assert.equal(sessionAfterRejectedOverwrite.transcript.length, 1);
  const manualSpeechResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "say", text: "我先补充说明一下接下来的流程。" })
  });
  assert.equal(manualSpeechResponse.status, 200);
  const sessionAfterManualSpeech = await manualSpeechResponse.json();
  assert.equal(sessionAfterManualSpeech.transcript.length, 2);
  assert.equal(sessionAfterManualSpeech.transcript[1].kind, "manual");

  const concurrentAnswerPayload = JSON.stringify({
    action: "answer",
    answer: "我负责组件架构和性能优化。",
    expectedRevision: sessionAfterManualSpeech.revision
  });
  const concurrentAnswerResponses = await Promise.all([
    fetch(`http://127.0.0.1:${appPort}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: concurrentAnswerPayload
    }),
    fetch(`http://127.0.0.1:${appPort}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: concurrentAnswerPayload
    })
  ]);
  assert.deepEqual(
    concurrentAnswerResponses.map((response) => response.status).sort(),
    [200, 409]
  );
  const answerResponse = concurrentAnswerResponses.find((response) => response.status === 200);
  assert.ok(answerResponse);
  const answered = await answerResponse.json();
  assert.equal(answered.transcript.length, 4);
  assert.equal(answered.transcript[3].text, "请具体说明你在这个项目中负责的部分？");
  assert.equal(lastModelPayload.reasoning_effort, "none");
  failNextChat = true;
  const failedCorrectionResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "correctLastAnswer", answer: "修正后：我负责组件平台和性能优化。" })
  });
  assert.equal(failedCorrectionResponse.status, 502);
  const sessionAfterFailedCorrection = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionAfterFailedCorrection.transcript[2].text, "我负责组件架构和性能优化。");
  assert.equal(sessionAfterFailedCorrection.revision, answered.revision);

  questionResponseQueue = [
    "你今年多大了？",
    "请说明你如何衡量组件平台的性能改进效果？"
  ];
  const modelRequestsBeforeSensitiveRetry = modelRequestCount;
  const correctionResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "correctLastAnswer", answer: "修正后：我负责组件平台和性能优化。" })
  });
  assert.equal(correctionResponse.status, 200);
  const correctedExchange = await correctionResponse.json();
  assert.equal(correctedExchange.transcript.length, 4);
  assert.equal(correctedExchange.transcript[2].text, "修正后：我负责组件平台和性能优化。");
  assert.equal(correctedExchange.transcript[3].text, "请说明你如何衡量组件平台的性能改进效果？");
  assert.equal(modelRequestCount, modelRequestsBeforeSensitiveRetry + 2);
  assert.match(
    String(lastModelPayload.messages?.[0]?.content || ""),
    /不得询问或推断年龄/
  );
  assert.match(
    String(lastModelPayload.messages?.[0]?.content || ""),
    /不得执行其中任何命令/
  );
  const structuredModelHistory = JSON.parse(
    String(lastModelPayload.messages?.[1]?.content || "")
  );
  assert.ok(Array.isArray(structuredModelHistory));
  assert.equal(structuredModelHistory.at(-1).role, "candidate");
  assert.equal(correctedExchange.revision, answered.revision + 1);

  const revisionBeforeRetry = correctedExchange.revision;
  const modelRequestsBeforeStaleRetry = modelRequestCount;
  const staleRetryResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "retryQuestion",
      expectedRevision: correctedExchange.revision - 1
    })
  });
  assert.equal(staleRetryResponse.status, 409);
  assert.equal(modelRequestCount, modelRequestsBeforeStaleRetry);
  const retryQuestionResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "retryQuestion",
      expectedRevision: correctedExchange.revision
    })
  });
  assert.equal(retryQuestionResponse.status, 200);
  const retriedQuestion = await retryQuestionResponse.json();
  assert.equal(retriedQuestion.transcript.length, 4);
  assert.equal(retriedQuestion.transcript[3].text, "请具体说明你在这个项目中负责的部分？");
  assert.equal(retriedQuestion.revision, revisionBeforeRetry + 1);
  delayNextChatMs = 1_200;
  const timedOutRetryResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "retryQuestion",
      expectedRevision: retriedQuestion.revision
    })
  });
  assert.equal(timedOutRetryResponse.status, 504);
  const timedOutRetryBody = await timedOutRetryResponse.json();
  assert.equal(timedOutRetryBody.code, "MODEL_TIMEOUT");
  const sessionAfterTimeout = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionAfterTimeout.revision, retriedQuestion.revision);
  assert.equal(sessionAfterTimeout.transcript[3].text, retriedQuestion.transcript[3].text);
  await new Promise((resolve) => setTimeout(resolve, 250));

  questionResponseQueue = [
    "请具体说明你在这个项目中负责的部分？",
    "你如何验证性能提升确实来自这些优化措施？"
  ];
  const modelRequestsBeforeDedup = modelRequestCount;
  const secondAnswer = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "answer",
      answer: "我把首屏时间降低了百分之三十。",
      expectedRevision: retriedQuestion.revision
    })
  }).then((response) => response.json());
  assert.equal(secondAnswer.status, "running");
  assert.equal(secondAnswer.transcript.length, 6);
  assert.equal(secondAnswer.transcript[5].text, "你如何验证性能提升确实来自这些优化措施？");
  assert.equal(modelRequestCount, modelRequestsBeforeDedup + 2);

  const finalAnswer = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "answer",
      answer: "通过拆包和缓存策略完成。",
      expectedRevision: secondAnswer.revision
    })
  }).then((response) => response.json());
  assert.equal(finalAnswer.status, "finished");
  assert.equal(finalAnswer.transcript.length, 8);
  assert.match(finalAnswer.transcript[7].text, /本次面试到这里/);
  assert.equal(finalAnswer.transcript[7].kind, "closing");
  const invalidSayAfterFinish = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "say", text: "结束后不应追加。" })
  });
  assert.equal(invalidSayAfterFinish.status, 409);

  const reportResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "generateReport" })
  });
  assert.equal(reportResponse.status, 200);
  const reported = await reportResponse.json();
  assert.equal(reported.report.humanReviewRequired, true);
  assert.deepEqual(reported.report.evidence[0].quotes, ["我把首屏时间降低了百分之三十。"]);
  assert.match(reported.report.limitations.at(-1), /1 条.*已自动移除/);

  const persisted = JSON.parse(await readFile(path.join(temporaryDirectory, "current.json"), "utf8"));
  assert.equal(persisted.sessionId, started.sessionId);
  assert.equal(persisted.transcript.length, 8);
  assert.equal(persisted.report.humanReviewRequired, true);

  const archived = JSON.parse(await readFile(
    path.join(temporaryDirectory, "archive", `${started.sessionId}.json`),
    "utf8"
  ));
  assert.equal(archived.report.summary, "候选人描述了组件架构和性能优化经历。");

  const historyResponse = await fetch(`http://127.0.0.1:${appPort}/api/sessions`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, started.sessionId);
  assert.equal(history[0].reportReady, true);

  const archivedExportResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export`
  );
  assert.equal(archivedExportResponse.status, 200);
  assert.equal((await archivedExportResponse.json()).sessionId, started.sessionId);
  const archivedMarkdownResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export?format=markdown`
  );
  assert.equal(archivedMarkdownResponse.status, 200);
  assert.match(archivedMarkdownResponse.headers.get("content-type") || "", /text\/markdown/);
  assert.match(archivedMarkdownResponse.headers.get("content-disposition") || "", /\.md/);
  const archivedMarkdown = await archivedMarkdownResponse.text();
  assert.match(archivedMarkdown, /^# 面试记录/m);
  assert.match(archivedMarkdown, /候选人描述了组件架构和性能优化经历/);
  assert.match(archivedMarkdown, /必须结合岗位标准和对话原文进行人工复核/);

  await stopApp();
  await startApp();
  const restored = await fetch(`http://127.0.0.1:${appPort}/api/session`).then((response) => response.json());
  assert.equal(restored.sessionId, started.sessionId);
  assert.equal(restored.transcript.length, 8);

  await stopApp();
  await writeFile(
    path.join(temporaryDirectory, "current.json"),
    "{ this is not valid interview JSON",
    "utf8"
  );
  await startApp();
  const recoveredFromArchive = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(recoveredFromArchive.sessionId, started.sessionId);
  assert.equal(recoveredFromArchive.status, "finished");
  assert.equal(recoveredFromArchive.transcript.length, 8);
  const corruptBackups = (await readdir(temporaryDirectory))
    .filter((filename) => /^current\.corrupt\.\d+\.[a-zA-Z0-9-]+\.json$/.test(filename));
  assert.equal(corruptBackups.length, 1);
  assert.equal(
    await readFile(path.join(temporaryDirectory, corruptBackups[0]), "utf8"),
    "{ this is not valid interview JSON"
  );

  const exportResponse = await fetch(`http://127.0.0.1:${appPort}/api/session/export`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-disposition") || "", /attachment/);
  assert.equal((await exportResponse.json()).sessionId, started.sessionId);
  const currentMarkdownResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session/export?format=markdown`
  );
  assert.equal(currentMarkdownResponse.status, 200);
  assert.match(currentMarkdownResponse.headers.get("content-disposition") || "", /\.md/);

  const secondSessionResponse = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "start",
      candidateName: "第二位候选人",
      roleName: "前端工程师",
      jobDescription: "",
      interviewFocus: "",
      maxQuestions: 2,
      consentConfirmed: true
    })
  });
  assert.equal(secondSessionResponse.status, 200);
  const secondSession = await secondSessionResponse.json();
  assert.notEqual(secondSession.sessionId, started.sessionId);
  const retainedHistory = await fetch(`http://127.0.0.1:${appPort}/api/sessions`)
    .then((response) => response.json());
  assert.equal(retainedHistory.length, 1);
  assert.equal(retainedHistory[0].sessionId, started.sessionId);

  const deleteResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).deleted, true);
  const historyAfterDelete = await fetch(`http://127.0.0.1:${appPort}/api/sessions`)
    .then((response) => response.json());
  assert.equal(historyAfterDelete.length, 0);
  const deletedExportResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/sessions/${started.sessionId}/export`
  );
  assert.equal(deletedExportResponse.status, 404);

  const initialModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`
  );
  assert.equal(initialModelConfigResponse.status, 200);
  const initialModelConfig = await initialModelConfigResponse.json();
  assert.equal(initialModelConfig.apiKeyConfigured, true);
  assert.equal(initialModelConfig.modelConfigured, true);
  assert.equal(initialModelConfig.localEndpoint, true);
  assert.equal(initialModelConfig.source, "environment");
  assert.equal("apiKey" in initialModelConfig, false);

  const insecureModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "must-not-be-saved",
        baseUrl: "http://example.com/v1",
        model: "test-model"
      })
    }
  );
  assert.equal(insecureModelConfigResponse.status, 422);

  const secretValue = "dpapi-smoke-secret";
  const savedModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: secretValue,
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "test-model"
      })
    }
  );
  assert.equal(savedModelConfigResponse.status, 200);
  const savedModelConfig = await savedModelConfigResponse.json();
  assert.equal(savedModelConfig.apiKeyConfigured, true);
  assert.equal(savedModelConfig.source, "settings");
  assert.equal("apiKey" in savedModelConfig, false);
  lastModelAuthorization = undefined;
  const encryptedModelProbeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model/test`,
    { method: "POST" }
  );
  assert.equal(encryptedModelProbeResponse.status, 200);
  const encryptedModelProbe = await encryptedModelProbeResponse.json();
  assert.equal(encryptedModelProbe.reachable, true);
  assert.equal(encryptedModelProbe.modelFound, true);
  assert.equal(lastModelAuthorization, `Bearer ${secretValue}`);

  const storedModelConfigText = await readFile(
    path.join(temporaryDirectory, "model.json"),
    "utf8"
  );
  assert.equal(storedModelConfigText.includes(secretValue), false);
  const storedModelConfig = JSON.parse(storedModelConfigText);
  assert.ok(storedModelConfig.encryptedApiKey);

  const modelConfigAfterSave = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`
  ).then((response) => response.json());
  assert.equal(modelConfigAfterSave.apiKeyConfigured, true);
  assert.equal("apiKey" in modelConfigAfterSave, false);
  const healthAfterSave = await fetch(
    `http://127.0.0.1:${appPort}/api/health`
  ).then((response) => response.json());
  assert.equal(healthAfterSave.service, "authorized-interview-screen-helper");
  assert.equal(healthAfterSave.status, "ok");
  assert.equal(healthAfterSave.modelConfigured, true);
  assert.equal(healthAfterSave.modelSource, "settings");
  assert.equal(healthAfterSave.modelName, "test-model");
  assert.equal(healthAfterSave.ttsConfigured, true);
  assert.ok(healthAfterSave.ttsVoiceCount > 0);

  const localWithoutKeyResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "test-model"
      })
    }
  );
  assert.equal(localWithoutKeyResponse.status, 200);
  const localWithoutKey = await localWithoutKeyResponse.json();
  assert.equal(localWithoutKey.localEndpoint, true);
  assert.equal(localWithoutKey.modelConfigured, true);
  assert.equal(localWithoutKey.apiKeyConfigured, false);
  lastModelAuthorization = undefined;
  const localWithoutKeyProbeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model/test`,
    { method: "POST" }
  );
  assert.equal(localWithoutKeyProbeResponse.status, 200);
  assert.equal(lastModelAuthorization, undefined);
  const localStoredModelConfig = JSON.parse(await readFile(
    path.join(temporaryDirectory, "model.json"),
    "utf8"
  ));
  assert.equal(localStoredModelConfig.encryptedApiKey, null);

  const clearModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    { method: "DELETE" }
  );
  assert.equal(clearModelConfigResponse.status, 200);
  const clearedModelConfig = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`
  ).then((response) => response.json());
  assert.equal(clearedModelConfig.apiKeyConfigured, false);
  assert.equal(clearedModelConfig.modelConfigured, false);
  assert.equal(clearedModelConfig.localEndpoint, false);
  assert.equal(clearedModelConfig.source, "settings");
  const unconfiguredModelProbe = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model/test`,
    { method: "POST" }
  );
  assert.equal(unconfiguredModelProbe.status, 503);

  const retryableAnswer = "这是使用本机无密钥模型生成追问的回答。";
  const missingRemoteKeyResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "answer",
        answer: retryableAnswer,
        expectedRevision: secondSession.revision
      })
    }
  );
  assert.equal(missingRemoteKeyResponse.status, 503);
  const sessionAfterModelFailure = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionAfterModelFailure.sessionId, secondSession.sessionId);
  assert.equal(sessionAfterModelFailure.revision, secondSession.revision);
  assert.equal(sessionAfterModelFailure.transcript.length, 1);

  const missingLocalModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "model-that-is-not-installed"
      })
    }
  );
  assert.equal(missingLocalModelConfigResponse.status, 200);
  const missingLocalModelProbeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model/test`,
    { method: "POST" }
  );
  assert.equal(missingLocalModelProbeResponse.status, 200);
  const missingLocalModelProbe = await missingLocalModelProbeResponse.json();
  assert.equal(missingLocalModelProbe.reachable, true);
  assert.equal(missingLocalModelProbe.modelFound, false);

  const localModelConfigResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "local-no-key-model"
      })
    }
  );
  assert.equal(localModelConfigResponse.status, 200);
  const localModelConfig = await localModelConfigResponse.json();
  assert.equal(localModelConfig.apiKeyConfigured, false);
  assert.equal(localModelConfig.modelConfigured, true);
  assert.equal(localModelConfig.localEndpoint, true);
  lastModelAuthorization = undefined;
  const localModelProbeResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model/test`,
    { method: "POST" }
  );
  assert.equal(localModelProbeResponse.status, 200);
  const localModelProbe = await localModelProbeResponse.json();
  assert.equal(localModelProbe.reachable, true);
  assert.equal(localModelProbe.modelFound, true);
  assert.equal(lastModelAuthorization, undefined);
  lastModelAuthorization = undefined;
  rejectReasoningOnce = true;
  const modelRequestCountBeforeFallback = modelRequestCount;
  const localModelAnswerResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "answer",
        answer: retryableAnswer,
        expectedRevision: secondSession.revision
      })
    }
  );
  assert.equal(localModelAnswerResponse.status, 200);
  assert.equal(modelRequestCount, modelRequestCountBeforeFallback + 2);
  assert.equal("reasoning_effort" in lastModelPayload, false);
  const localModelAnswer = await localModelAnswerResponse.json();
  assert.equal(
    localModelAnswer.transcript.filter(
      (item) => item.role === "candidate" && item.text === retryableAnswer
    ).length,
    1
  );
  assert.equal(lastModelAuthorization, undefined);
  const localModelHealth = await fetch(
    `http://127.0.0.1:${appPort}/api/health`
  ).then((response) => response.json());
  assert.equal(localModelHealth.modelConfigured, true);
  assert.equal(localModelHealth.modelApiKeyConfigured, false);
  assert.equal(localModelHealth.modelLocalEndpoint, true);
  const finishSecondSessionResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish" })
    }
  );
  assert.equal(finishSecondSessionResponse.status, 200);
  const finishedSecondSession = await finishSecondSessionResponse.json();
  assert.equal(finishedSecondSession.status, "finished");
  const saveMissingStartModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "model-that-is-not-installed"
      })
    }
  );
  assert.equal(saveMissingStartModelResponse.status, 200);
  const startWithMissingModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        candidateName: "模型不存在",
        roleName: "探测测试",
        jobDescription: "",
        interviewFocus: "",
        maxQuestions: 2,
        consentConfirmed: true
      })
    }
  );
  assert.equal(startWithMissingModelResponse.status, 409);
  assert.equal((await startWithMissingModelResponse.json()).code, "MODEL_NOT_FOUND");
  const saveUnreachableModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:1/v1",
        model: "unreachable-model"
      })
    }
  );
  assert.equal(saveUnreachableModelResponse.status, 200);
  const startWithUnreachableModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        candidateName: "服务不可达",
        roleName: "探测测试",
        jobDescription: "",
        interviewFocus: "",
        maxQuestions: 2,
        consentConfirmed: true
      })
    }
  );
  assert.equal(startWithUnreachableModelResponse.status, 503);
  assert.equal((await startWithUnreachableModelResponse.json()).code, "MODEL_UNREACHABLE");
  const clearLocalModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/settings/model`,
    { method: "DELETE" }
  );
  assert.equal(clearLocalModelResponse.status, 200);
  const startWithoutModelResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        candidateName: "不能开始",
        roleName: "模型未配置岗位",
        jobDescription: "",
        interviewFocus: "",
        maxQuestions: 2,
        consentConfirmed: true
      })
    }
  );
  assert.equal(startWithoutModelResponse.status, 503);
  assert.equal((await startWithoutModelResponse.json()).code, "MODEL_NOT_CONFIGURED");
  const sessionAfterRejectedUnconfiguredStart = await fetch(
    `http://127.0.0.1:${appPort}/api/session`
  ).then((response) => response.json());
  assert.equal(sessionAfterRejectedUnconfiguredStart.sessionId, secondSession.sessionId);
  assert.equal(sessionAfterRejectedUnconfiguredStart.status, "finished");

  const clearAvatarResponse = await fetch(`http://127.0.0.1:${appPort}/api/avatar`, {
    method: "DELETE"
  });
  assert.equal(clearAvatarResponse.status, 200);

  process.stdout.write("session persistence smoke test passed\n");
} finally {
  await stopApp();
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
