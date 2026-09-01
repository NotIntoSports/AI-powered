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
  assert.match(adapter, /singlePeerConnection:\s*false/);
  assert.match(session, /onTransportState/);
  assert.match(session, /onAgentPresence/);
  assert.match(controller, /onTransportState/);
  assert.match(controller, /onAgentPresence/);
  assert.match(controller, /requestAutoBridgeRestart/);
  assert.match(controller, /agent-missing/);
  assert.match(adapter, /ParticipantConnected/);
  assert.match(adapter, /isAgent/);
  assert.doesNotMatch(session, /@volcengine\/rtc/);
});

test("auto-bridge card can restart a dead room and surface missing Agent", async () => {
  const [controller, card, workspaceCard, adapter] = await Promise.all([
    readFile(new URL("../../features/rtc/auto-bridge-controller.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../features/rtc/rtc-bridge-control.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../features/rtc/meeting-bridge-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8")
  ]);
  assert.match(controller, /requestAutoBridgeRestart/);
  assert.match(controller, /agent-missing/);
  assert.match(controller, /AGENT_WAIT_MS = 8_000/);
  assert.match(card, /重新桥接/);
  assert.match(card, /LiveKit 自动运行中/);
  assert.match(workspaceCard, /autoStatus\.state === "agent-missing"/);
  assert.match(workspaceCard, /requestAutoBridgeRestart/);
  assert.match(workspaceCard, />重新桥接<\/button>/);
  assert.match(adapter, /participant\.isAgent/);
});

test("auto-bridge keeps Agent presence seen during connect instead of resetting after the room is ready", async () => {
  const controller = await readFile(new URL("../../features/rtc/auto-bridge-controller.tsx", import.meta.url), "utf8");
  const watch = controller.match(/function watchAgentForRoom\([^)]*\) \{[\s\S]*?\n    \}/);
  assert.ok(watch, "watchAgentForRoom should be present");
  assert.doesNotMatch(watch[0], /agentPresent = false/);
  assert.match(watch[0], /if \(agentPresent\)/);
  assert.match(controller, /agentPresent = false;\s*\n\s*clearAgentWait\(\);\s*\n\s*try \{\s*\n\s*const handle = await startBridgeSession/);
});

test("desktop sends versioned session context to the Agent without model configuration", async () => {
  const [contract, adapter, playback, session] = await Promise.all([
    readFile(new URL("../../lib/subtitles/transport.ts", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/rtc/livekit-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/audio/agent-audio-playback.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/rtc/bridge-session.ts", import.meta.url), "utf8")
  ]);
  assert.match(contract, /sessionContext/);
  assert.match(adapter, /session\.context\.v1/);
  assert.match(adapter, /publishData/);
  assert.match(adapter, /TrackSubscribed/);
  assert.match(playback, /setSinkId/);
  assert.match(adapter, /loadVirtualAudioRoute/);
  assert.match(session, /\/api\/session/);
  assert.doesNotMatch(contract, /apiKey|baseUrl|providerId|modelId/);
});
