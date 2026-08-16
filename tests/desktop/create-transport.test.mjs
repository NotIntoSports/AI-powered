import assert from "node:assert/strict";
import test from "node:test";

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
