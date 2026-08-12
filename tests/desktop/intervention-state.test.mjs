import assert from "node:assert/strict";
import test from "node:test";

import {
  beginIntervention,
  emergencyMute,
  endIntervention,
  initialInterventionState,
  resumeAi
} from "../../features/intervention/intervention-state.ts";

test("push-to-talk pauses AI and release does not resume it", () => {
  let state = beginIntervention(initialInterventionState());
  assert.equal(state.aiPaused, true);
  assert.equal(state.ttsActive, false);
  assert.equal(state.humanMicActive, true);
  state = endIntervention(state);
  assert.equal(state.humanMicActive, false);
  assert.equal(state.aiPaused, true);
  state = resumeAi(state);
  assert.equal(state.aiPaused, false);
});

test("emergency mute disables every output", () => {
  const state = emergencyMute({ ...initialInterventionState(), ttsActive: true, humanMicActive: true });
  assert.equal(state.muted, true);
  assert.equal(state.ttsActive, false);
  assert.equal(state.humanMicActive, false);
  assert.equal(state.aiPaused, true);
});
