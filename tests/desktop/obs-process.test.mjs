import assert from "node:assert/strict";
import test from "node:test";

import { buildManagedObsArgs, detectManagedObs, managedObsExecutable, startOwnedObs } from "../../desktop/obs-process.ts";

test("detects only the managed portable OBS executable", () => {
  const root = "C:\\AI\\runtime\\obs";
  const result = detectManagedObs(root, (candidate) => candidate === managedObsExecutable(root));
  assert.equal(result?.executablePath, "C:\\AI\\runtime\\obs\\bin\\64bit\\obs64.exe");
});

test("managed OBS arguments isolate configuration without exposing credentials", () => {
  const args = buildManagedObsArgs();
  for (const expected of ["--portable", "--multi", "--only-bundled-plugins", "--disable-updater", "--disable-missing-files-check", "--minimize-to-tray", "--websocket_ipv4_only"]) assert.ok(args.includes(expected));
  assert.equal(args.some((argument) => /password/i.test(argument)), false);
  assert.equal(args.includes("--websocket_port"), false);
});

test("marks only a spawned OBS process as owned and keeps secrets out of argv", () => {
  const child = { kill: () => true, pid: 42 };
  let spawnedArgs = [];
  const result = startOwnedObs(
    { executablePath: "C:\\OBS\\bin\\64bit\\obs64.exe" },
    (_executable, args) => { spawnedArgs = args; return child; }
  );
  assert.equal(result.owned, true);
  assert.equal(result.child, child);
  assert.equal(spawnedArgs.some((argument) => /password/i.test(argument)), false);
  assert.equal(spawnedArgs.includes("--websocket_port"), false);
});
