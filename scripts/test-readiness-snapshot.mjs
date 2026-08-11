import assert from "node:assert/strict";

const {
  READINESS_VERIFICATION_TTL_MS,
  getSnapshotReadiness,
  parseReadinessSnapshot,
  updateReadinessSnapshot
} = await import("../features/readiness/readiness-snapshot.ts");

const now = 1_000_000;
assert.deepEqual(parseReadinessSnapshot(null), {});
assert.deepEqual(parseReadinessSnapshot("not-json"), {});
assert.deepEqual(parseReadinessSnapshot(JSON.stringify({ speechReady: now, secret: "ignored" })), {
  speechReady: now
});

let snapshot = {};
for (const id of [
  "speechReady", "obsConnected", "virtualCameraActive", "virtualCameraVerified",
  "virtualAudioReady", "meetingPreviewConfirmed"
]) {
  snapshot = updateReadinessSnapshot(snapshot, id, true, now);
}
assert.equal(Object.values(getSnapshotReadiness(snapshot, now + 1)).every(Boolean), true);
assert.equal(
  Object.values(getSnapshotReadiness(snapshot, now + READINESS_VERIFICATION_TTL_MS)).some(Boolean),
  false
);

snapshot = updateReadinessSnapshot(snapshot, "virtualCameraActive", false, now + 2);
assert.equal(snapshot.virtualCameraActive, undefined);
assert.equal(snapshot.virtualCameraVerified, undefined);
assert.equal(snapshot.virtualAudioReady, undefined);
assert.equal(snapshot.meetingPreviewConfirmed, undefined);
assert.equal(snapshot.obsConnected, now);

process.stdout.write("readiness snapshot test passed\n");
