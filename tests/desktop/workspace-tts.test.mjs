import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as ttsPolicy from "../../features/audio/tts-output-policy.ts";
import { parseLocalAiMonitorEnabled } from "../../features/audio/local-ai-monitor.ts";

const referenceModeModule = await import("../../features/audio/ai-reference-mode.ts").catch(() => ({}));
const { requireVirtualTtsSink } = ttsPolicy;

test("local AI monitor defaults on and persists explicit choices", () => {
  assert.equal(parseLocalAiMonitorEnabled(null), true);
  assert.equal(parseLocalAiMonitorEnabled("1"), true);
  assert.equal(parseLocalAiMonitorEnabled("true"), true);
  assert.equal(parseLocalAiMonitorEnabled("0"), false);
  assert.equal(parseLocalAiMonitorEnabled("false"), false);
});

test("strict TTS output requires a resolved VB-CABLE sink and setSinkId", () => {
  assert.deepEqual(requireVirtualTtsSink({ sinkId: null, setSinkSupported: true }), {
    ok: false,
    code: "VIRTUAL_AUDIO_ROUTE_NOT_READY"
  });
  assert.deepEqual(requireVirtualTtsSink({ sinkId: "cable-input", setSinkSupported: false }), {
    ok: false,
    code: "SET_SINK_ID_UNSUPPORTED"
  });
  assert.deepEqual(requireVirtualTtsSink({ sinkId: "cable-input", setSinkSupported: true }), {
    ok: true,
    sinkId: "cable-input"
  });
});

test("AI reference mode keeps generated text but suppresses session TTS", () => {
  assert.equal(typeof ttsPolicy.shouldSynthesizeSessionSpeech, "function");
  assert.equal(ttsPolicy.shouldSynthesizeSessionSpeech({ referenceMode: false, text: "建议回答" }), true);
  assert.equal(ttsPolicy.shouldSynthesizeSessionSpeech({ referenceMode: true, text: "建议回答" }), false);
  assert.equal(ttsPolicy.shouldSynthesizeSessionSpeech({ referenceMode: false, text: "  " }), false);
});

test("AI reference mode defaults off and persists explicit choices", () => {
  assert.equal(typeof referenceModeModule.parseAiReferenceModeEnabled, "function");
  assert.equal(referenceModeModule.parseAiReferenceModeEnabled(null), false);
  assert.equal(referenceModeModule.parseAiReferenceModeEnabled("1"), true);
  assert.equal(referenceModeModule.parseAiReferenceModeEnabled("false"), false);
});

test("LiveKit adapter owns Agent audio and stage is visual-only", async () => {
  const workspace = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const stage = await readFile(new URL("../../app/stage/page.tsx", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(workspace, /useWorkspaceTts|\/api\/tts/);
  assert.match(controller, /setSinkId/);
  assert.match(controller, /TrackSubscribed/);
  assert.match(controller, /loadLocalAiMonitorEnabled/);
  assert.doesNotMatch(controller, /speechSynthesis|playWebSpeech|\/api\/tts/);
  assert.doesNotMatch(stage, /\/api\/tts|setSinkId|speechSynthesis/);
});

test("Agent audio output failure is logged without credentials", async () => {
  const controller = await readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8");
  assert.match(controller, /agent audio output failed/);
  assert.doesNotMatch(controller, /apiKey|apiSecret/);
});

test("intervention controls expose an independent local AI monitor switch", async () => {
  const source = await readFile(new URL("../../features/intervention/intervention-controls.tsx", import.meta.url), "utf8");
  assert.match(source, /本机听到 AI 播报/);
  assert.match(source, /loadLocalAiMonitorEnabled/);
  assert.match(source, /saveLocalAiMonitorEnabled/);
});
