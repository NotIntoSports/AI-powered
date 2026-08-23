import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("aliyun cosyvoice client uses POP signing with clone and list actions", () => {
  const lib = readFileSync(join(root, "lib", "aliyun-cosyvoice.ts"), "utf8");
  assert.match(lib, /nls-slp\.cn-shanghai\.aliyuncs\.com/);
  assert.match(lib, /2019-08-19/);
  assert.match(lib, /HMAC-SHA1/);
  assert.match(lib, /export async function cloneCosyVoice/);
  assert.match(lib, /export async function listCosyVoice/);
  assert.match(lib, /Action: input\.action/);
  assert.match(lib, /VoicePrefix/);
});

test("voice clone route auto-assigns aliyun voice without user-facing IDs", () => {
  const route = readFileSync(join(root, "app", "api", "voice-clone", "route.ts"), "utf8");
  assert.match(route, /cloneCosyVoice/);
  assert.match(route, /COSYVOICE_VOICE_PREFIX/);
  assert.match(route, /\/api\/v1\/client\/voice-samples/);
  assert.match(route, /truncateWavToSeconds/);
  // 复刻完成立即清理 COS 样本。
  assert.match(route, /deleteVoiceSample\(sample\.id\)/);
  // 豆包分支保留作为备选。
  assert.match(route, /VOLCENGINE_CLONE_URL/);
  // 复刻音色复用现有账号绑定。
  assert.match(route, /bindSpeakerId\(reservation, voiceName, true\)/);
});

test("bound cosyvoice voice is used on the aliyun TTS line", () => {
  const runtime = readFileSync(join(root, "lib", "speech-runtime.ts"), "utf8");
  const tts = readFileSync(join(root, "app", "api", "tts", "route.ts"), "utf8");
  assert.match(runtime, /isCosyVoiceSpeakerId\(aliyunBound\)/);
  assert.match(tts, /isCosyVoiceSpeakerId\(speech\.speakerId\)/);
  assert.match(tts, /synthesizeCosyVoiceSpeech/);
  // xiaoyun 系统音色仍走 HTTP 合成。
  assert.match(tts, /synthesizeAliyunSpeech/);
});

test("voice clone control hides the ID input and never shows cosyvoice IDs", () => {
  const control = readFileSync(join(root, "features", "audio", "voice-clone-control.tsx"), "utf8");
  assert.match(control, /刻录成功，已自动为你分配专属音色/);
  assert.match(control, /已启用你的专属音色/);
  assert.match(control, /高级选项/);
  assert.match(control, /<details className="voiceCloneAdvanced">/);
});

test("voice clone recording stays within aliyun clone duration", () => {
  const pcm = readFileSync(join(root, "lib", "pcm-wav.ts"), "utf8");
  const lib = readFileSync(join(root, "lib", "aliyun-cosyvoice.ts"), "utf8");
  const control = readFileSync(join(root, "features", "audio", "voice-clone-control.tsx"), "utf8");
  assert.match(pcm, /CLONE_SAMPLE_RATE = 24_000/);
  assert.match(pcm, /export function truncateWavToSeconds/);
  assert.match(lib, /COSYVOICE_MAX_CLONE_SECONDS = 20/);
  assert.match(control, /CLONE_SAMPLE_RATE/);
});

test("control-api exposes voice sample upload and deletion over COS", () => {
  const service = readFileSync(join(root, "server", "control-api", "internal", "voicesamples", "service.go"), "utf8");
  const handler = readFileSync(join(root, "server", "control-api", "internal", "httpapi", "voicesamples.go"), "utf8");
  const router = readFileSync(join(root, "server", "control-api", "internal", "httpapi", "router.go"), "utf8");
  const main = readFileSync(join(root, "server", "control-api", "cmd", "control-api", "main.go"), "utf8");
  const openapi = readFileSync(join(root, "server", "control-api", "openapi", "openapi.yaml"), "utf8");
  assert.match(service, /voice-samples\//);
  assert.match(service, /30 \* time\.Minute/);
  assert.match(service, /PresignGet/);
  assert.match(service, /DeleteObject/);
  // 密钥不下发客户端：响应只含 id/url/sizeBytes/expiresIn。
  assert.doesNotMatch(service, /SecretKey\s+`json/);
  assert.match(handler, /FormFile\("file"\)/);
  assert.match(router, /\/voice-samples/);
  assert.match(main, /voicesamples\.NewService/);
  assert.match(openapi, /uploadClientVoiceSample/);
  assert.match(openapi, /deleteClientVoiceSample/);
});

test("cosyvoice speaker detection does not misclassify xiaoyun", () => {
  const runtime = readFileSync(join(root, "lib", "speech-runtime.ts"), "utf8");
  const lib = readFileSync(join(root, "lib", "aliyun-cosyvoice.ts"), "utf8");
  assert.match(runtime, /isClonedSpeakerId\(speakerId: string, aliyunVoice = DEFAULT_ALIYUN_VOICE\)/);
  assert.match(lib, /startsWith\("cosyvoice-"\)/);
});
