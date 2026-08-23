import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("voice clone API reserves one account allocation before binding", () => {
  const route = readFileSync(join(root, "app", "api", "voice-clone", "route.ts"), "utf8");
  assert.match(route, /SpeechVoiceAllocationError/);
	assert.match(route, /reserveAllocation/);
	assert.match(route, /VOICE_ALREADY_ALLOCATED/);
  assert.match(route, /VOICE_BIND_FAILED/);
  assert.match(route, /bound: true/);
  assert.match(route, /bound: false/);
});

test("speech runtime exposes reserve complete and release allocation operations", () => {
  const runtime = readFileSync(join(root, "lib", "speech-runtime.ts"), "utf8");
  assert.match(runtime, /reserveSpeechVoiceAllocation/);
	assert.match(runtime, /completeSpeechVoiceAllocation/);
	assert.match(runtime, /releaseSpeechVoiceAllocation/);
  assert.doesNotMatch(runtime, /\.catch\(\(\) => null\)/);
});

test("voice clone control shows bind success and sync failure copy", () => {
  const control = readFileSync(join(root, "features", "audio", "voice-clone-control.tsx"), "utf8");
  assert.match(control, /每个账号仅可分配一次/);
  assert.match(control, /VOICE_BIND_FAILED/);
  assert.match(control, /账号同步失败/);
});

test("cloned speaker is enabled for TTS even when Aliyun is the active line", () => {
  const runtime = readFileSync(join(root, "lib", "speech-runtime.ts"), "utf8");
  const route = readFileSync(join(root, "app", "api", "voice-clone", "route.ts"), "utf8");
  const tts = readFileSync(join(root, "app", "api", "tts", "route.ts"), "utf8");
  assert.match(runtime, /export function isClonedSpeakerId/);
  assert.match(runtime, /export async function getTtsRuntimeConfig/);
  assert.match(runtime, /export async function getVolcengineSpeechConfig/);
  assert.match(route, /resourceId: volcengine\.ttsResourceId/);
  assert.match(route, /enabled: true/);
  assert.match(route, /getVolcengineSpeechConfig/);
  assert.match(tts, /getTtsRuntimeConfig/);
});
