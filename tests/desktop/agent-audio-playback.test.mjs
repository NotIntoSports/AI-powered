import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { AgentAudioPlaybackController } from "../../features/audio/agent-audio-playback.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const events = [];
  let elementId = 0;
  const elements = new Map();
  const track = {
    sid: "TR_agent",
    attach() {
      const id = ++elementId;
      const element = {
        id,
        async setSinkId(deviceId) { events.push(`sink:${id}:${deviceId}`); },
        async play() { events.push(`play:${id}`); },
        pause() { events.push(`pause:${id}`); },
        remove() { events.push(`remove:${id}`); },
      };
      elements.set(id, element);
      events.push(`attach:${id}`);
      return element;
    },
    detach(element) { events.push(`detach:${element.id}`); },
  };
  return { events, track, elements };
}

test("starts virtual output before attaching the local monitor", async () => {
  const { events, track } = fixture();
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
  });

  await controller.addTrack(track, true);

  assert.deepEqual(events.slice(0, 5), [
    "attach:1", "sink:1:vb-cable", "play:1", "attach:2", "play:2",
  ]);
});

test("monitor toggle detaches only its own element and does not duplicate it", async () => {
  const { events, track } = fixture();
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
  });
  await controller.addTrack(track, true);

  await controller.setMonitorEnabled(false);
  await controller.setMonitorEnabled(false);
  await controller.setMonitorEnabled(true);
  await controller.setMonitorEnabled(true);

  assert.equal(events.filter((event) => event === "detach:2").length, 1);
  assert.equal(events.filter((event) => event.startsWith("attach:")).length, 3);
  assert.equal(events.includes("detach:1"), false);
});

test("generation guard discards stale startup after a track is removed", async () => {
  const route = deferred();
  const { events, track } = fixture();
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: () => route.promise,
  });

  const startup = controller.addTrack(track, true);
  controller.removeTrack(track);
  route.resolve("vb-cable");
  await startup;

  assert.equal(events.some((event) => event.startsWith("attach:")), false);
});

test("removed track cannot play after setSinkId finishes", async () => {
  const sink = deferred();
  const { events, track } = fixture();
  const originalAttach = track.attach;
  track.attach = function attach() {
    const element = originalAttach.call(this);
    element.setSinkId = async (deviceId) => {
      events.push(`sink:${element.id}:${deviceId}`);
      await sink.promise;
    };
    return element;
  };
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
  });

  const startup = controller.addTrack(track, false);
  await new Promise((resolve) => setImmediate(resolve));
  controller.removeTrack(track);
  sink.resolve();
  await startup;

  assert.equal(events.some((event) => event.startsWith("play:")), false);
});

test("virtual route failure detaches the failed element", async () => {
  const { events, track } = fixture();
  const originalAttach = track.attach;
  track.attach = function attach() {
    const element = originalAttach.call(this);
    element.setSinkId = async () => { throw new Error("SET_SINK_ID_FAILED"); };
    return element;
  };
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
  });

  await controller.addTrack(track, true);

  assert.equal(events.includes("detach:1"), true);
  assert.equal(events.some((event) => event === "attach:2"), false);
});

test("rapid monitor off-on ends with exactly one playing monitor", async () => {
  const monitorPlay = deferred();
  const { events, track } = fixture();
  const originalAttach = track.attach;
  track.attach = function attach() {
    const element = originalAttach.call(this);
    if (element.id > 1) {
      element.play = async () => {
        events.push(`play:${element.id}`);
        if (element.id === 2) await monitorPlay.promise;
      };
    }
    return element;
  };
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
  });

  const startup = controller.addTrack(track, true);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.setMonitorEnabled(false);
  const enabling = controller.setMonitorEnabled(true);
  monitorPlay.resolve();
  await Promise.all([startup, enabling]);

  assert.equal(events.filter((event) => event.startsWith("attach:")).length, 3);
  assert.equal(events.filter((event) => event === "play:3").length, 1);
});

test("retry starts room audio and retries blocked routes for existing tracks", async () => {
  const { events, track } = fixture();
  let block = true;
  const originalAttach = track.attach;
  track.attach = function attach() {
    const element = originalAttach.call(this);
    element.play = async () => {
      events.push(`play:${element.id}`);
      if (block) {
        const error = new Error("blocked");
        error.name = "NotAllowedError";
        throw error;
      }
    };
    return element;
  };
  const statuses = [];
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async () => "vb-cable",
    startRoomAudio: async () => { events.push("room:startAudio"); block = false; },
    onStatus: (status) => statuses.push(`${status.route}:${status.state}`),
  });

  await controller.addTrack(track, true);
  assert.equal(statuses.includes("virtual-output:blocked"), true);
  await controller.retryPlayback();

  assert.equal(events.includes("room:startAudio"), true);
  assert.equal(statuses.includes("virtual-output:playing"), true);
  assert.equal(statuses.includes("local-monitor:playing"), true);
});

test("missing signal retries one fallback virtual endpoint before local monitor", async () => {
  const { events, track } = fixture();
  const attempts = [];
  const statuses = [];
  const controller = new AgentAudioPlaybackController({
    resolveVirtualOutputDeviceId: async (attempt = 0) => {
      attempts.push(attempt);
      return { deviceId: attempt ? "cable-16" : "cable-stereo", endpointLabel: attempt ? "CABLE In 16ch" : "CABLE Input" };
    },
    verifyVirtualSignal: async (route) => route.deviceId === "cable-16" ? "detected" : "missing",
    onStatus: (status) => statuses.push(status),
  });
  await controller.addTrack(track, true);
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(events.includes("sink:1:cable-stereo"), true);
  assert.equal(events.includes("sink:2:cable-16"), true);
  assert.equal(statuses.some((status) => status.endpointLabel === "CABLE In 16ch" && status.signalState === "detected"), true);
  assert.equal(events.at(-1), "play:3");
});

test("LiveKit adapter and intervention UI expose autoplay recovery and separate route status", async () => {
  const [adapter, intervention] = await Promise.all([
    readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/intervention/intervention-controls.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(adapter, /RoomEvent\.AudioPlaybackStatusChanged/);
  assert.match(adapter, /room\.startAudio\(\)/);
  assert.match(adapter, /ai-audio-route-status/);
  assert.match(adapter, /ai-audio-retry-request/);
  assert.match(intervention, /会议输出/);
  assert.match(intervention, /本机监听/);
  assert.match(intervention, /重新启用 AI 声音/);
});
