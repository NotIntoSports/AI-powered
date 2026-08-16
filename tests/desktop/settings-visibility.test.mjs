import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop settings do not expose RTC, AI, or transcription configuration", async () => {
  const source = await readFile(new URL("../../app/settings/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RtcSettings/);
  assert.doesNotMatch(source, /title="实时字幕"/);
  assert.doesNotMatch(source, /ModelSettings/);
  assert.match(source, /number="01" title="会议画面"/);
  assert.match(source, /使用自己的真实摄像头/);
  assert.match(source, /使用 OBS 虚拟摄像头输出数字人/);
  assert.match(source, /number="02" title="系统诊断"/);
  assert.match(source, /number="03" title="数字人形象"/);
  assert.match(source, /virtualMode && <SettingSection number="03"/);
  assert.match(source, /label="语音转写"/);
  assert.match(source, /label="网络"/);
  assert.match(source, /已由管理端配置/);
  assert.match(source, /请在管理后台配置语音转写/);
  assert.match(source, /当前未使用虚拟摄像头/);
  assert.match(source, /可选。不上传则使用默认数字人形象。/);
});

test("OBS automatic connection uses a bounded 30 second cold-start window", async () => {
  const source = await readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8");
  assert.match(source, /MANAGED_OBS_STARTUP_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(source, /PORT_POLL_INTERVAL_MS\s*=\s*500/);
  assert.match(source, /Date\.now\(\) \+ MANAGED_OBS_STARTUP_TIMEOUT_MS/);
  assert.match(source, /OBS_PORT_NOT_READY/);
});
