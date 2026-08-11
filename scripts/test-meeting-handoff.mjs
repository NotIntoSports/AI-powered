import assert from "node:assert/strict";

const { canConfirmMeetingHandoff } = await import(
  "../features/meeting/meeting-handoff.ts"
);

const ready = {
  prerequisitesReady: true,
  software: "腾讯会议",
  videoConfirmed: true,
  audioConfirmed: true
};

assert.equal(canConfirmMeetingHandoff(ready), true);
for (const key of ["prerequisitesReady", "videoConfirmed", "audioConfirmed"]) {
  assert.equal(
    canConfirmMeetingHandoff({ ...ready, [key]: false }),
    false,
    `${key} must be required`
  );
}
assert.equal(canConfirmMeetingHandoff({ ...ready, software: "" }), false);
assert.equal(canConfirmMeetingHandoff({ ...ready, software: "   " }), false);
assert.equal(
  canConfirmMeetingHandoff({ ...ready, software: "候选人临时指定的软件" }),
  true
);

process.stdout.write("meeting handoff test passed\n");
