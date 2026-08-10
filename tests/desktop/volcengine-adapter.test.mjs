import assert from "node:assert/strict";
import test from "node:test";

import { VolcengineRtcAdapter } from "../../desktop/rtc/volcengine-adapter.ts";

test("connects, attaches external track, and starts recognition subtitles", async () => {
  const calls = [];
  const engine = {
    on: (name) => calls.push(["on", name]),
    joinRoom: async (...args) => calls.push(["joinRoom", ...args]),
    setAudioSourceType: async (...args) => calls.push(["setAudioSourceType", ...args]),
    setExternalAudioTrack: async (...args) => calls.push(["setExternalAudioTrack", ...args]),
    publishStream: async (...args) => calls.push(["publishStream", ...args]),
    startSubtitle: async (...args) => calls.push(["startSubtitle", ...args]),
    stopSubtitle: () => calls.push(["stopSubtitle"]),
    leaveRoom: () => calls.push(["leaveRoom"])
  };
  const adapter = new VolcengineRtcAdapter(engine);
  await adapter.connect({ token: "short-token", roomId: "room", userId: "bridge", language: "zh", track: {} });
  assert.ok(calls.some(([name]) => name === "setExternalAudioTrack"));
  assert.ok(calls.some(([name]) => name === "startSubtitle"));
  await adapter.disconnect();
  assert.ok(calls.some(([name]) => name === "leaveRoom"));
});
