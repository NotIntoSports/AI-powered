import assert from "node:assert/strict";
import test from "node:test";

import { parseSubtitleInput } from "../../lib/subtitles/contract.ts";
import { mergeSubtitle } from "../../lib/subtitles/merge.ts";
import { createSubtitleSink } from "../../lib/subtitles/sink.ts";
import { mapLiveKitDataPacket, mapLiveKitSegment } from "../../lib/subtitles/map-livekit.ts";

function event(overrides = {}) {
  return {
    sessionId: "interview_1",
    utteranceId: "seg_1",
    text: "我有",
    final: false,
    language: "zh",
    ...overrides
  };
}

test("rejects subtitle payloads that are not v1", () => {
  assert.equal(parseSubtitleInput({ sessionId: "s", utteranceId: "1", text: "hi", final: true, v: 2 }).ok, false);
  assert.equal(parseSubtitleInput({ sessionId: "s", utteranceId: "1", text: "", final: true }).ok, false);
  assert.equal(parseSubtitleInput({ sessionId: "s", text: "hi", final: true }).ok, false);
});

test("final subtitles replace partial text and cannot be overwritten by partials", () => {
  let state = mergeSubtitle([], event());
  state = mergeSubtitle(state, event({ text: "我有三年经验", final: true }));
  state = mergeSubtitle(state, event({ text: "旧增量", final: false }));
  assert.equal(state.length, 1);
  assert.equal(state[0].text, "我有三年经验");
  assert.equal(state[0].final, true);
});

test("orders different utterances by emittedAt then receivedAt", () => {
  let state = mergeSubtitle([], event({
    utteranceId: "b",
    text: "二",
    final: true,
    emittedAt: "2026-08-16T07:00:02.000Z"
  }), 20);
  state = mergeSubtitle(state, event({
    utteranceId: "a",
    text: "一",
    final: true,
    emittedAt: "2026-08-16T07:00:01.000Z"
  }), 10);
  assert.deepEqual(state.map((item) => item.utteranceId), ["a", "b"]);
});

test("sink publishes mapped events and exposes final-only subscription", () => {
  const sink = createSubtitleSink();
  const snapshots = [];
  const finals = [];
  sink.subscribe((lines) => snapshots.push(lines.map((item) => item.text)));
  sink.subscribeFinal((line) => finals.push(line.text));
  sink.publish(event({ text: "我" }));
  sink.publish(event({ text: "我有三年经验", final: true }));
  sink.publish({ v: 1, sessionId: "interview_1", utteranceId: "seg_1", text: "", final: true });
  assert.equal(snapshots.at(-1)?.[0], "我有三年经验");
  assert.deepEqual(finals, ["我有三年经验"]);
});

test("livekit mapper accepts segments and v1 data packets", () => {
  const fromSegment = mapLiveKitSegment({ id: "seg_a", text: "可以", final: false }, "interview_1");
  assert.equal(fromSegment?.utteranceId, "seg_a");
  assert.equal(fromSegment?.final, false);
  const packet = mapLiveKitDataPacket(JSON.stringify({
    v: 1,
    sessionId: "interview_1",
    utteranceId: "seg_a",
    text: "可以的",
    final: true,
    language: "zh"
  }), "interview_1");
  assert.equal(packet?.text, "可以的");
  assert.equal(packet?.final, true);
  assert.equal(packet?.source, "livekit");
});

test("livekit agent v1 packets round-trip through the mapper into the sink", () => {
  const sink = createSubtitleSink();
  const packet = JSON.stringify({
    v: 1,
    sessionId: "interview_agent",
    speaker: "candidate",
    utteranceId: "utt_1",
    text: "我可以远程转写",
    final: true,
    language: "zh",
    emittedAt: "2026-08-16T07:00:00.000Z",
    source: "livekit"
  });
  const mapped = mapLiveKitDataPacket(packet, "interview_agent");
  sink.publish(mapped);
  assert.equal(sink.snapshot()[0]?.utteranceId, "utt_1");
  assert.equal(sink.snapshot()[0]?.final, true);
  assert.equal(sink.snapshot()[0]?.source, "livekit");
});
