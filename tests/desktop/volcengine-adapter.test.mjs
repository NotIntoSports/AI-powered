import assert from "node:assert/strict";
import test from "node:test";

import { createSubtitleSink } from "../../lib/subtitles/sink.ts";
import { VolcengineRtcAdapter } from "../../desktop/rtc/volcengine-adapter.ts";

test("connects, attaches external track, and starts recognition subtitles", async () => {
  const calls = [];
  const published = [];
  const engine = {
    on: (name, listener) => { calls.push(["on", name]); engine.listener = listener; },
    listener: undefined,
    joinRoom: async (...args) => calls.push(["joinRoom", ...args]),
    setAudioSourceType: async (...args) => calls.push(["setAudioSourceType", ...args]),
    setExternalAudioTrack: async (...args) => calls.push(["setExternalAudioTrack", ...args]),
    publishStream: async (...args) => calls.push(["publishStream", ...args]),
    startSubtitle: async (...args) => calls.push(["startSubtitle", ...args]),
    stopSubtitle: () => calls.push(["stopSubtitle"]),
    leaveRoom: () => calls.push(["leaveRoom"])
  };
  const sink = createSubtitleSink();
  sink.subscribe((lines) => { published.splice(0, published.length, ...lines); });
  const adapter = new VolcengineRtcAdapter(engine, sink);
  await adapter.connect({
    sessionId: "interview_1",
    token: "short-token",
    roomId: "room",
    userId: "bridge",
    language: "zh",
    track: {}
  });
  assert.ok(calls.some(([name]) => name === "setExternalAudioTrack"));
  assert.ok(calls.some(([name]) => name === "startSubtitle"));
  engine.listener?.([{ sequence: 3, text: "你好", definite: true }]);
  assert.equal(published[0]?.utteranceId, "3");
  assert.equal(published[0]?.final, true);
  assert.equal(published[0]?.source, "volcengine");
  await adapter.disconnect();
  assert.ok(calls.some(([name]) => name === "leaveRoom"));
});
