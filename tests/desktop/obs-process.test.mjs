import assert from "node:assert/strict";
import test from "node:test";

import { detectObsFromCandidates, startOwnedObs } from "../../desktop/obs-process.ts";

test("detects the first existing OBS executable candidate", () => {
  const result = detectObsFromCandidates(
    ["C:\\missing\\obs64.exe", "C:\\OBS\\bin\\64bit\\obs64.exe"],
    (candidate) => candidate.includes("C:\\OBS")
  );
  assert.equal(result?.executablePath, "C:\\OBS\\bin\\64bit\\obs64.exe");
});

test("marks only a spawned OBS process as owned", () => {
  const child = { kill: () => true };
  const result = startOwnedObs(
    { executablePath: "C:\\OBS\\bin\\64bit\\obs64.exe" },
    () => child
  );
  assert.equal(result.owned, true);
  assert.equal(result.child, child);
});
