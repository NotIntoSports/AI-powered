import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("voice clone API surfaces account bind failures", () => {
  const route = readFileSync(join(root, "app", "api", "voice-clone", "route.ts"), "utf8");
  assert.match(route, /SpeechAccountBindError/);
  assert.match(route, /VOICE_BIND_FAILED/);
  assert.match(route, /bound: true/);
  assert.match(route, /bound: false/);
});

test("speech runtime no longer swallows account sync failures", () => {
  const runtime = readFileSync(join(root, "lib", "speech-runtime.ts"), "utf8");
  assert.match(runtime, /class SpeechAccountBindError/);
  assert.match(runtime, /throw new SpeechAccountBindError/);
  assert.doesNotMatch(runtime, /\.catch\(\(\) => null\)/);
});

test("voice clone control shows bind success and sync failure copy", () => {
  const control = readFileSync(join(root, "features", "audio", "voice-clone-control.tsx"), "utf8");
  assert.match(control, /刻录成功，已绑定本账号音色/);
  assert.match(control, /VOICE_BIND_FAILED/);
  assert.match(control, /账号同步失败/);
});
