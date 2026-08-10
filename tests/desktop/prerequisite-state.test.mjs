import assert from "node:assert/strict";
import test from "node:test";
import { advanceInstallState } from "../../desktop/prerequisites/state-machine.ts";

test("installation steps advance and resume after reboot", () => {
  let state = { step: "obs", status: "not-started" };
  state = advanceInstallState(state, "start");
  state = advanceInstallState(state, "installed");
  state = advanceInstallState(state, "verified");
  assert.deepEqual(state, { step: "virtual-camera", status: "not-started" });
  state = advanceInstallState(advanceInstallState(state, "start"), "reboot");
  state = advanceInstallState(state, "verified");
  assert.deepEqual(state, { step: "virtual-audio", status: "not-started" });
});

test("invalid transitions fail and can retry", () => {
  let state = advanceInstallState({ step: "obs", status: "not-started" }, "verified");
  assert.equal(state.status, "failed");
  state = advanceInstallState(state, "retry");
  assert.equal(state.status, "not-started");
});
