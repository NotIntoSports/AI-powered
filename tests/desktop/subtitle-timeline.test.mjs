import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectTimelineSubtitleLines } from "../../features/subtitles/timeline.ts";

const partial = {
  sessionId: "meet_1",
  speaker: "candidate",
  utteranceId: "u1",
  text: "正在识别",
  final: false,
  language: "zh",
  receivedAt: 100
};
const final = { ...partial, utteranceId: "u2", text: "已经确认", final: true, receivedAt: 200 };

test("idle timeline keeps partial and final subtitles as temporary messages", () => {
  assert.deepEqual(
    selectTimelineSubtitleLines({ lines: [partial, final], status: "idle" }),
    [partial, final]
  );
});

test("running timeline exposes only the newest partial so final text is not duplicated", () => {
  assert.deepEqual(
    selectTimelineSubtitleLines({ lines: [partial, final], status: "running" }),
    [partial]
  );
});

test("finished timeline shows only subtitles received after the finish boundary", () => {
  assert.deepEqual(
    selectTimelineSubtitleLines({
      lines: [partial, final],
      status: "finished",
      finishedAt: new Date(150).toISOString()
    }),
    [final]
  );
});

test("workspace renders subtitles in the transcript and removes the sidebar subtitle card", async () => {
  const source = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /selectTimelineSubtitleLines/);
  assert.match(source, /className="message candidate live subtitlePreview"/);
  assert.doesNotMatch(source, /<LiveSubtitles\s*\/>/);
  assert.doesNotMatch(source, /问题上限/);
  assert.doesNotMatch(source, /!consentConfirmed\s*\|\|\s*session\.status/);
});
