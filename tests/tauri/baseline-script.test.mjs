import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("legacy baseline script emits bounded machine-readable metrics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-baseline-"));
  const outputPath = path.join(directory, "baseline.json");

  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/measure-desktop-baseline.ps1"),
        "-OutputPath",
        outputPath,
      ],
      { cwd: path.resolve("."), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdout = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    const persisted = JSON.parse(
      (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, ""),
    );

    assert.deepEqual(persisted, stdout);
    assert.deepEqual(Object.keys(stdout), [
      "commit",
      "measuredAt",
      "installerBytes",
      "runtimeBytes",
      "startupMs",
      "idleWorkingSetBytes",
      "idleCpuPercent",
    ]);
    assert.match(stdout.commit, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(stdout.measuredAt)));

    for (const field of [
      "installerBytes",
      "runtimeBytes",
      "startupMs",
      "idleWorkingSetBytes",
      "idleCpuPercent",
    ]) {
      assert.equal(stdout[field], null);
    }

    assert.doesNotMatch(result.stdout, /API[_-]?KEY|PASSWORD|TOKEN/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
