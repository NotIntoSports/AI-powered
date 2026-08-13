import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop settings do not expose RTC or subtitle configuration", async () => {
  const source = await readFile(new URL("../../app/settings/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RtcSettings/);
  assert.doesNotMatch(source, /title="实时字幕"/);
  assert.match(source, /number="01" title="系统诊断"/);
  assert.match(source, /number="03" title="数字人形象"/);
  assert.ok(source.indexOf('title="系统诊断"') < source.indexOf('title="AI 模型"'));
});

test("OBS automatic connection uses a bounded 30 second cold-start window", async () => {
  const source = await readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8");
  assert.match(source, /MANAGED_OBS_STARTUP_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(source, /PORT_POLL_INTERVAL_MS\s*=\s*500/);
  assert.match(source, /Date\.now\(\) \+ MANAGED_OBS_STARTUP_TIMEOUT_MS/);
  assert.match(source, /OBS_PORT_NOT_READY/);
});
