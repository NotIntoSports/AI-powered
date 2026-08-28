import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import { createSubtitleSink } from "../../lib/subtitles/sink.ts";

test("volcengine transport requires an engine and keeps the SDK adapter", async () => {
  const sink = createSubtitleSink();
  await assert.rejects(() => createSubtitleTransport("volcengine", sink), /VOLCENGINE_ENGINE_REQUIRED/);
  const transport = await createSubtitleTransport("volcengine", sink, {
    on() {},
    async joinRoom() {},
    async setAudioSourceType() {},
    async setExternalAudioTrack() {},
    async publishStream() {},
    async startSubtitle() {},
    stopSubtitle() {},
    leaveRoom() {}
  });
  assert.equal(transport.provider, "volcengine");
});

test("livekit transport is selected without a volcengine engine", async () => {
  const sink = createSubtitleSink();
  const transport = await createSubtitleTransport("livekit", sink);
  assert.equal(transport.provider, "livekit");
});

test("LiveKit connection lifecycle is propagated through the transport contract", async () => {
  const [contract, adapter, session, controller] = await Promise.all([
    readFile(new URL("../../lib/subtitles/transport.ts", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/rtc/bridge-session.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/rtc/auto-bridge-controller.tsx", import.meta.url), "utf8")
  ]);
  assert.match(contract, /onConnectionStateChange/);
  assert.match(adapter, /onConnectionStateChange\?\.\("reconnecting"/);
  assert.match(adapter, /onConnectionStateChange\?\.\("disconnected"/);
  assert.match(session, /onTransportState/);
  assert.match(controller, /onTransportState/);
});
