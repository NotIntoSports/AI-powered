import assert from "node:assert/strict";
import test from "node:test";

import { buildManagedObsArgs, detectManagedObs, managedObsExecutable, startOwnedObs } from "../../desktop/obs-process.ts";

test("detects only the managed portable OBS executable", () => {
  const root = "C:\\AI\\runtime\\obs";
  const result = detectManagedObs(root, (candidate) => candidate === managedObsExecutable(root));
  assert.equal(result?.executablePath, "C:\\AI\\runtime\\obs\\bin\\64bit\\obs64.exe");
});

test("managed OBS arguments isolate configuration and disable interactive prompts", () => {
  const args = buildManagedObsArgs(4455, "test-password");
  for (const expected of ["--portable", "--multi", "--only-bundled-plugins", "--disable-updater", "--disable-missing-files-check", "--minimize-to-tray", "--websocket_ipv4_only"]) assert.ok(args.includes(expected));
  assert.deepEqual(args.slice(-4), ["--websocket_port", "4455", "--websocket_password", "test-password"]);
});

test("marks only a spawned OBS process as owned", () => {
  const child = { kill: () => true };
  let spawnedArgs = [];
  const result = startOwnedObs(
    { executablePath: "C:\\OBS\\bin\\64bit\\obs64.exe" },
    "test-password",
    4455,
    (_executable, args) => { spawnedArgs = args; return child; }
  );
  assert.equal(result.owned, true);
  assert.equal(result.child, child);
  assert.ok(spawnedArgs.includes("--websocket_password"));
  assert.ok(spawnedArgs.includes("test-password"));
});
