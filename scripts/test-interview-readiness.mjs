import assert from "node:assert/strict";

const readinessSource = await import("../features/readiness/interview-readiness.ts");
const outputModeSource = await import("../features/readiness/output-mode.ts");
const { getInterviewReadiness, isReadinessItemRequired } = readinessSource;
const { parseOutputMode, DEFAULT_OUTPUT_MODE } = outputModeSource;

const allReady = {
  stageConnected: true,
  mediaReady: true,
  speechReady: true,
  obsConnected: true,
  virtualCameraActive: true,
  virtualCameraVerified: true,
  virtualAudioReady: true,
  meetingPreviewConfirmed: true
};

assert.equal(DEFAULT_OUTPUT_MODE, "real");
assert.equal(parseOutputMode(null), "real");
assert.equal(parseOutputMode("virtual"), "virtual");
assert.equal(parseOutputMode("unknown"), "real");
assert.equal(isReadinessItemRequired("stageConnected", "real"), false);
assert.equal(isReadinessItemRequired("virtualCameraActive", "real"), false);
assert.equal(isReadinessItemRequired("mediaReady", "virtual"), false);
assert.equal(isReadinessItemRequired("virtualCameraActive", "virtual"), true);

assert.equal(getInterviewReadiness(allReady).ready, true);
assert.deepEqual(getInterviewReadiness(allReady).missing, []);
assert.deepEqual(getInterviewReadiness({ ...allReady, stageConnected: false }).missing, []);
assert.equal(getInterviewReadiness({ ...allReady, virtualCameraActive: false }).ready, true);

const virtualReady = { ...allReady, outputMode: "virtual" };
assert.equal(getInterviewReadiness(virtualReady).ready, true);
assert.deepEqual(getInterviewReadiness(virtualReady).missing, []);
assert.equal(getInterviewReadiness({ ...virtualReady, mediaReady: false }).ready, true);
assert.deepEqual(getInterviewReadiness({ ...virtualReady, mediaReady: false }).missing, []);

for (const key of Object.keys(allReady)) {
  if (key === "mediaReady") continue;
  const result = getInterviewReadiness({ ...virtualReady, [key]: false });
  assert.equal(result.ready, false, `${key} must be required in virtual mode`);
  assert.deepEqual(result.missing.map((item) => item.id), [key]);
}

process.stdout.write("interview readiness test passed\n");
