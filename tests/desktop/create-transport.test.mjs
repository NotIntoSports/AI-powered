import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import { createSubtitleSink } from "../../lib/subtitles/sink.ts";

test("createSubtitleTransport always returns livekit transport", async () => {
  const sink = createSubtitleSink();
  const transport = await createSubtitleTransport(sink);
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
  assert.doesNotMatch(session, /@volcengine\/rtc/);
});
