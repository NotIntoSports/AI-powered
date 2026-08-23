import assert from "node:assert/strict";
import test from "node:test";

import * as intervention from "../../features/intervention/intervention-state.ts";

const {
  beginIntervention,
  emergencyMute,
  endIntervention,
  initialInterventionState,
  resumeAi
} = intervention;

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

test("clicking the intervention control toggles the human microphone without resuming AI", () => {
  assert.equal(typeof intervention.toggleIntervention, "function");
  const speaking = intervention.toggleIntervention(initialInterventionState());
  assert.equal(speaking.humanMicActive, true);
  assert.equal(speaking.aiPaused, true);

  const stopped = intervention.toggleIntervention(speaking);
  assert.equal(stopped.humanMicActive, false);
  assert.equal(stopped.aiPaused, true);
});
