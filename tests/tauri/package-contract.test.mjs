import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAllowedProcessTree,
  assertBundleContainsNoPrivateFiles,
  requirePackagedExecutable,
} from "../../scripts/test-tauri-package.mjs";

test("missing packaged executable stops the smoke test", async () => {
  await assert.rejects(
    requirePackagedExecutable(join(tmpdir(), "missing-tauri-foundation.exe")),
    /Packaged executable does not exist/,
  );
});

test("bundle inspection rejects private runtime files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-bundle-contract-"));
  try {
    await mkdir(join(fixture, "config"), { recursive: true });
    await writeFile(join(fixture, "config", "local.json"), "{}", "utf8");

    await assert.rejects(
      assertBundleContainsNoPrivateFiles(fixture),
      /config[\\/]local\.json/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bundle inspection permits normal application artifacts", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-bundle-contract-"));
  try {
    await mkdir(join(fixture, "resources"), { recursive: true });
    await writeFile(join(fixture, "resources", "app.bin"), "foundation", "utf8");
    await assert.doesNotReject(assertBundleContainsNoPrivateFiles(fixture));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("process inspection rejects forbidden service descendants", () => {
  assert.throws(
    () => assertAllowedProcessTree([
      { processId: 4100, parentProcessId: 4000, name: "AI Virtual Assistant.exe" },
      { processId: 4200, parentProcessId: 4100, name: "python.exe" },
    ]),
    /python\.exe/,
  );
});
