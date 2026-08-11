import assert from "node:assert/strict";

const source = await import("../features/readiness/interview-readiness.ts");
const { getInterviewReadiness } = source;

const allReady = {
  modelConfigured: true,
  stageConnected: true,
  mediaReady: true,
  speechReady: true,
  obsConnected: true,
  virtualCameraActive: true,
  virtualCameraVerified: true,
  virtualAudioReady: true,
  meetingPreviewConfirmed: true
};

assert.equal(getInterviewReadiness(allReady).ready, true);
assert.deepEqual(getInterviewReadiness(allReady).missing, []);

for (const key of Object.keys(allReady)) {
  const result = getInterviewReadiness({ ...allReady, [key]: false });
  assert.equal(result.ready, false, `${key} must be required`);
  assert.deepEqual(result.missing.map((item) => item.id), [key]);
}

process.stdout.write("interview readiness test passed\n");
