import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyClonedVoiceTtsFailure,
  clonedVoicePreviewMessage
} from "../../lib/cloned-voice-tts-error.ts";

test("classifies expired cloned voice quota without exposing upstream details", () => {
  const result = classifyClonedVoiceTtsFailure(new Error("Gateway:FREE_TRIAL_EXPIRED:The free trial has expired!"));
  assert.equal(result.status, 503);
  assert.equal(result.code, "CLONED_VOICE_QUOTA_EXPIRED");
  assert.doesNotMatch(result.message, /Gateway|FREE_TRIAL_EXPIRED|expired!/);
  assert.match(clonedVoicePreviewMessage(result.code), /额度已过期.*未播放默认音色/);
});

test("classifies other cloned voice failures as unavailable", () => {
  const result = classifyClonedVoiceTtsFailure(new Error("internal upstream details"));
  assert.equal(result.status, 502);
  assert.equal(result.code, "CLONED_VOICE_UNAVAILABLE");
  assert.doesNotMatch(result.message, /upstream/);
});

test("TTS route keeps cloned voices out of the SAPI fallback path", async () => {
  const source = await readFile(new URL("../../app/api/tts/route.ts", import.meta.url), "utf8");
  assert.match(source, /if \(clonedVoice\)[\s\S]*classifyClonedVoiceTtsFailure/);
  assert.doesNotMatch(source, /speakerId=\$\{speech\.speakerId/);
});
