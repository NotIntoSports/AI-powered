import assert from "node:assert/strict";
import test from "node:test";

import { startHumanMicrophoneBridge } from "../../features/audio/human-microphone-bridge.ts";

test("human microphone bridge uses the saved virtual output and releases all media", async () => {
  const calls = [];
  const track = { stop: () => calls.push("track.stop") };
  const stream = { getTracks: () => [track] };
  const audio = {
    srcObject: null,
    autoplay: false,
    setSinkId: async (id) => calls.push(`sink:${id}`),
    play: async () => calls.push("play"),
    pause: () => calls.push("pause"),
    remove: () => calls.push("remove"),
  };
  const bridge = await startHumanMicrophoneBridge({
    route: {
      provider: "vb-cable", label: "VB-CABLE", input: "CABLE Output", output: "CABLE Input",
      inputDeviceId: "old-in", outputDeviceId: "old-out",
    },
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: "audioinput", label: "CABLE Output", deviceId: "virtual-in" },
        { kind: "audiooutput", label: "CABLE Input", deviceId: "virtual-out" },
      ],
      getUserMedia: async () => stream,
    },
    createAudio: () => audio,
  });
  assert.equal(bridge.outputLabel, "CABLE Input");
  assert.deepEqual(calls, ["sink:virtual-out", "play"]);
  bridge.stop();
  assert.deepEqual(calls, ["sink:virtual-out", "play", "pause", "track.stop", "remove"]);
});

test("human microphone bridge fails before capture when the saved route is unavailable", async () => {
  let captured = false;
  await assert.rejects(() => startHumanMicrophoneBridge({
    route: null,
    mediaDevices: {
      enumerateDevices: async () => [],
      getUserMedia: async () => { captured = true; throw new Error("unexpected"); },
    },
    createAudio: () => ({}),
  }), /VIRTUAL_AUDIO_ROUTE_NOT_READY/);
  assert.equal(captured, false);
});
