import assert from "node:assert/strict";
import test from "node:test";

import { decideAutoSessionStart } from "../../features/rtc/auto-session-start.ts";

const ready = {
  bridgeState: "captured",
  bridgeSessionKey: "meet_1",
  sessionStatus: "idle",
  assistantRole: "interviewer",
  pending: false
};

test("starts once when the LiveKit bridge is ready", () => {
  assert.equal(decideAutoSessionStart(ready).shouldStart, true);
  assert.equal(decideAutoSessionStart({ ...ready, attemptedSessionKey: "meet_1" }).shouldStart, false);
  assert.equal(decideAutoSessionStart({ ...ready, bridgeSessionKey: "meet_2", attemptedSessionKey: "meet_1" }).shouldStart, true);
});

test("does not auto start without a stable bridge key", () => {
  assert.equal(decideAutoSessionStart({ ...ready, bridgeSessionKey: undefined }).shouldStart, false);
});

test("does not restart a running session", () => {
  assert.equal(decideAutoSessionStart({ ...ready, sessionStatus: "running" }).shouldStart, false);
});

test("requires an explicitly selected assistant role", () => {
  const decision = decideAutoSessionStart({ ...ready, assistantRole: "" });
  assert.equal(decision.shouldStart, false);
  assert.match(decision.message, /请选择助手角色/);
});
