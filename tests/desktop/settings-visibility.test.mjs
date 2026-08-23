import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop settings do not expose RTC credentials or AI model configuration", async () => {
  const source = await readFile(new URL("../../app/settings/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RtcSettings/);
  assert.doesNotMatch(source, /title="实时字幕"/);
  assert.doesNotMatch(source, /ModelSettings/);
  assert.match(source, /RtcBridgeControl/);
  assert.match(source, /title="会议音频桥接"/);
  assert.match(source, /number="01" title="会议画面"/);
  assert.match(source, /使用自己的真实摄像头/);
  assert.match(source, /使用 OBS 虚拟摄像头输出助手画面/);
  assert.match(source, /麦克风仍可选虚拟声卡/);
  assert.match(source, /number="02" title="系统诊断"/);
  assert.match(source, /number="03" title="助手声音"/);
  assert.match(source, /virtualMode && <SettingSection number="04" title="助手形象"/);
  assert.match(source, /virtualMode && <SettingSection number="05" title="OBS/);
  assert.match(source, /AudioRouteControl onReadyChange=\{handleVirtualAudioReady\}/);
  assert.match(source, /MeetingHandoffControl/);
  assert.match(source, /outputMode=\{outputMode\}/);
  assert.match(source, /VirtualCameraPreview/);
  assert.match(source, /virtualMode \? <VirtualCameraPreview/);
  assert.match(source, /AppChrome current="settings"/);
  assert.match(source, /label="语音转写"/);
  assert.match(source, /label="网络"/);
  assert.match(source, /label="播报引擎"/);
  assert.match(source, /已从管理端同步/);
  assert.match(source, /请先登录客户端/);
  assert.doesNotMatch(source, /当前未使用虚拟摄像头/);
  assert.match(source, /可选。不上传则使用默认助手形象。/);
});

test("OBS automatic connection uses a bounded 30 second cold-start window", async () => {
  const source = await readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8");
  assert.match(source, /MANAGED_OBS_STARTUP_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(source, /PORT_POLL_INTERVAL_MS\s*=\s*500/);
  assert.match(source, /Date\.now\(\) \+ MANAGED_OBS_STARTUP_TIMEOUT_MS/);
  assert.match(source, /OBS_PORT_NOT_READY/);
});

test("virtual audio one-click installs the signed driver and stages TTS to the virtual sink", async () => {
  const audioRoute = await readFile(new URL("../../features/audio/audio-route-control.tsx", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../features/audio/workspace-tts.ts", import.meta.url), "utf8");
  assert.match(audioRoute, /CABLE Output/);
  assert.match(audioRoute, /CABLE Input/);
  assert.doesNotMatch(audioRoute, /www\.vb-cable\.com/);
  assert.doesNotMatch(audioRoute, /捐赠/);
  assert.match(audioRoute, /重启电脑后再检测/);
  assert.match(audioRoute, /ensureVirtualAudio\(/);
  assert.match(audioRoute, /installPrerequisite\("virtual-audio"\)/);
  assert.match(audioRoute, /virtualAudioPresentInDriverStore/);
  assert.match(audioRoute, /一键授权并检测/);
  assert.match(audioRoute, /setSinkId/);
  assert.match(audioRoute, /loadReadinessSnapshot/);
  assert.match(audioRoute, /正在自动检测虚拟声卡线路/);
  assert.match(audioRoute, /resolveStoredRouteAgainstDevices/);
  assert.match(audioRoute, /verifiedAt/);
  assert.doesNotMatch(audioRoute, /安装包中的虚拟音频驱动资源缺失/);
  assert.doesNotMatch(audioRoute, /\/api\/stage-test-speech/);
  assert.match(controller, /loadVirtualAudioRoute/);
  assert.match(controller, /resolveStoredRouteAgainstDevices/);
  assert.match(controller, /setSinkId/);
});

test("voice clone returns an ID, binds the account, and TTS prefers that speaker", async () => {
  const route = await readFile(new URL("../../app/api/voice-clone/route.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../lib/speech-runtime.ts", import.meta.url), "utf8");
  const tts = await readFile(new URL("../../app/api/tts/route.ts", import.meta.url), "utf8");
  const control = await readFile(new URL("../../features/audio/voice-clone-control.tsx", import.meta.url), "utf8");
  assert.match(route, /resourceId: volcengine\.ttsResourceId/);
  assert.match(route, /enabled: true/);
  assert.match(route, /getVolcengineSpeechConfig/);
  assert.match(runtime, /export async function getTtsRuntimeConfig/);
  assert.match(runtime, /isClonedSpeakerId/);
  assert.match(tts, /getTtsRuntimeConfig/);
  assert.match(control, /刻录成功，已启用音色 ID/);
});
