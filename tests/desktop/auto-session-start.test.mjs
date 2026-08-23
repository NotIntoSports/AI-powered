import assert from "node:assert/strict";
import test from "node:test";

import { decideAutoSessionStart } from "../../features/rtc/auto-session-start.ts";

const ready = {
  bridgeState: "captured",
  bridgeSessionKey: "meet_1",
  sessionStatus: "idle",
  modelConfigured: true,
  stageConnected: true,
  pending: false
};

test("starts once when bridge, model and stage are ready", () => {
  assert.equal(decideAutoSessionStart(ready).shouldStart, true);
  assert.equal(decideAutoSessionStart({ ...ready, attemptedSessionKey: "meet_1" }).shouldStart, false);
  assert.equal(decideAutoSessionStart({ ...ready, bridgeSessionKey: "meet_2", attemptedSessionKey: "meet_1" }).shouldStart, true);
});

test("does not auto start without model, stage or a stable bridge key", () => {
  assert.match(decideAutoSessionStart({ ...ready, modelConfigured: false }).message, /模型/);
  assert.match(decideAutoSessionStart({ ...ready, stageConnected: false }).message, /播报引擎/);
  assert.equal(decideAutoSessionStart({ ...ready, bridgeSessionKey: undefined }).shouldStart, false);
});

test("does not restart a running session", () => {
  assert.equal(decideAutoSessionStart({ ...ready, sessionStatus: "running" }).shouldStart, false);
});
