import assert from "node:assert/strict";
import test from "node:test";

import * as autoAnswerGate from "../../features/rtc/auto-answer-gate.ts";

const { getAutoAnswerBlockReason } = autoAnswerGate;

const ready = {
  enabled: true,
  processing: false,
  aiSpeaking: false,
  outsideEchoWindow: true,
  meaningful: true,
  sessionStatus: "running",
  currentRevision: 2,
  lastTranscriptRole: "interviewer"
};

test("auto answer diagnostics identify the consent/session gate before AI submission", () => {
  assert.equal(getAutoAnswerBlockReason({ ...ready, sessionStatus: "idle" }), "session-not-running");
  assert.equal(getAutoAnswerBlockReason({ ...ready, enabled: false }), "automatic-mode-paused");
  assert.equal(getAutoAnswerBlockReason({ ...ready, processing: true }), "previous-turn-processing");
  assert.equal(getAutoAnswerBlockReason({ ...ready, outsideEchoWindow: false }), "tts-echo-window");
});

test("auto answer diagnostics allow a final subtitle only at the expected running turn", () => {
  assert.equal(getAutoAnswerBlockReason(ready), "");
  assert.equal(getAutoAnswerBlockReason({ ...ready, lastTranscriptRole: "candidate" }), "turn-not-ready");
});

test("paused automatic mode silently leaves the subtitle unsubmitted", () => {
  assert.equal(typeof autoAnswerGate.getAutoAnswerBlockedMessage, "function");
  assert.equal(autoAnswerGate.getAutoAnswerBlockedMessage("automatic-mode-paused"), null);
  assert.equal(autoAnswerGate.getAutoAnswerBlockedMessage("previous-turn-processing"), "AI 正在处理上一轮，这句字幕未自动提交");
});
