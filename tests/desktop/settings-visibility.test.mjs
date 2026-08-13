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

test("OBS automatic connection has a small fixed retry limit", async () => {
  const source = await readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8");
  assert.match(source, /MAX_ATTEMPTS\s*=\s*5/);
  assert.match(source, /await wait\(1_500\)/);
  assert.match(source, /OBS_PORT_NOT_READY/);
});
