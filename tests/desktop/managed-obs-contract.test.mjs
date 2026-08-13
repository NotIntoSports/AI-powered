import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("managed OBS exposes bounded lifecycle and reset IPC", async () => {
  const manager = await readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../../desktop/ipc.ts", import.meta.url), "utf8");
  assert.match(manager, /MAX_ATTEMPTS = 5/);
  assert.match(manager, /await wait\(1_500\)/);
  assert.match(manager, /blocked-by-external-obs/);
  for (const code of ["OBS_PORT_NOT_READY", "OBS_AUTH_FAILED", "OBS_SCENE_CONFIG_FAILED", "OBS_VIRTUAL_CAMERA_FAILED"]) assert.match(manager, new RegExp(code));
  assert.match(ipc, /desktop:ensure-managed-obs/);
  assert.match(ipc, /desktop:reset-managed-obs-config/);
});

test("packaging uses the pinned official portable release", async () => {
  const manifest = await readFile(new URL("../../desktop/prerequisites/manifest.ts", import.meta.url), "utf8");
  const fetcher = await readFile(new URL("../../scripts/fetch-prerequisites.ps1", import.meta.url), "utf8");
  assert.match(manifest, /OBS-Studio-32\.2\.1-Windows-x64\.zip/);
  assert.match(manifest, /db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de/i);
  assert.match(fetcher, /portable_mode\.txt/);
  assert.match(fetcher, /OBS Project/);
});
