import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Tencent Meeting card documents the split speaker and microphone route", async () => {
  const source = await readFile("features/rtc/meeting-bridge-card.tsx", "utf8");
  assert.match(source, /扬声器选系统默认\/Realtek/);
  assert.match(source, /麦克风选 CABLE Output/);
  assert.match(source, /请勿把会议扬声器设为 CABLE In/);
});
