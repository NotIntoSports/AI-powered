import assert from "node:assert/strict";
import test from "node:test";

import { formatPipelineLog, normalizePipelineEvent } from "../../lib/pipeline-diagnostics.ts";
import { POST } from "../../app/api/pipeline-log/route.ts";
import { emitPipelineEvent } from "../../features/diagnostics/pipeline-log.ts";

test("pipeline diagnostics keep bounded correlation metadata without speech or credentials", () => {
  const normalized = normalizePipelineEvent({
    event: "auto-answer.blocked",
    traceId: "meet_123\nforged",
    fields: {
      reason: "consent-required",
      sessionStatus: "idle",
      final: true,
      textLength: 12,
      text: "candidate speech must not be logged",
      token: "secret-token",
      apiKey: "secret-key"
    }
  });

  assert.deepEqual(normalized, {
    event: "auto-answer.blocked",
    traceId: "meet_123 forged",
    fields: {
      final: true,
      reason: "consent-required",
      sessionStatus: "idle",
      textLength: 12
    }
  });
  assert.equal(
    formatPipelineLog(normalized),
    "[pipeline] event=auto-answer.blocked traceId=meet_123_forged final=true reason=consent-required sessionStatus=idle textLength=12"
  );
});

test("pipeline diagnostics reject malformed events and unbounded metadata", () => {
  assert.equal(normalizePipelineEvent({ event: "INVALID EVENT", fields: {} }), null);
  assert.equal(normalizePipelineEvent({ event: "tts.requested", fields: { detail: "x".repeat(200) } }), null);
  assert.equal(normalizePipelineEvent(null), null);
});

test("pipeline log route writes the sanitized event and rejects malformed input", async () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    const accepted = await POST(new Request("http://127.0.0.1/api/pipeline-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "subtitle.received",
        traceId: "meet_123",
        fields: { final: true, textLength: 8, text: "must-not-log" }
      })
    }));
    assert.equal(accepted.status, 204);
    assert.deepEqual(lines, ["[pipeline] event=subtitle.received traceId=meet_123 final=true textLength=8"]);

    const rejected = await POST(new Request("http://127.0.0.1/api/pipeline-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));
    assert.equal(rejected.status, 422);
  } finally {
    console.log = original;
  }
});

test("renderer emitter sends only normalized metadata to the local log route", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  };
  try {
    await emitPipelineEvent({
      event: "tts.requested",
      traceId: "session_1",
      fields: { textLength: 20, text: "must-not-leave-renderer", provider: "aliyun" }
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/pipeline-log");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    event: "tts.requested",
    traceId: "session_1",
    fields: { provider: "aliyun", textLength: 20 }
  });
});
