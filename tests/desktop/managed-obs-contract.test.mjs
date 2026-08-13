import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import * as obsConfig from "../../desktop/obs-config.ts";
import * as obsProcess from "../../desktop/obs-process.ts";

const localRequire = createRequire(import.meta.url);

async function loadTypeScriptModule(url, stubs = {}) {
  const source = await readFile(url, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: url.pathname
  }).outputText;
  const module = { exports: {} };
  const requireFromTest = (specifier) => stubs[specifier] ?? localRequire(specifier);
  const execute = new Function("exports", "require", "module", "__filename", "__dirname", compiled);
  execute(module.exports, requireFromTest, module, url.pathname, path.dirname(url.pathname));
  return module.exports;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("managed OBS writes an enabled, authenticated localhost control configuration", () => {
  const password = `managed-obs-test-${process.pid}`;
  const configuration = obsConfig.buildManagedObsWebSocketConfiguration(password);
  assert.deepEqual(
    {
      alerts_enabled: configuration.alerts_enabled,
      auth_required: configuration.auth_required,
      first_load: configuration.first_load,
      server_enabled: configuration.server_enabled,
      server_port: configuration.server_port
    },
    {
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_port: 4455
    }
  );
  assert.equal(digest(configuration.server_password), digest(password));
});

test("managed OBS upgrades an old runtime and restores websocket configuration", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "managed-obs-config-"));
  const templateRoot = path.join(scratch, "template");
  const runtimeRoot = path.join(scratch, "runtime");
  const password = `managed-obs-migration-${process.pid}`;
  const { prepareManagedObsRuntime } = await loadTypeScriptModule(
    new URL("../../desktop/managed-obs.ts", import.meta.url),
    {
      "./obs-config": obsConfig,
      "./obs-process": obsProcess,
      "./obs-scene": { configureManagedObsScene() {}, setManagedObsInterventionRouting() {} },
      "./obs-secret-store": { ManagedObsSecretError: class ManagedObsSecretError extends Error {} }
    }
  );
  try {
    await mkdir(path.join(templateRoot, "bin", "64bit"), { recursive: true });
    await writeFile(path.join(templateRoot, "bin", "64bit", "obs64.exe"), "template", "utf8");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(runtimeRoot, ".managed-version.json"), JSON.stringify({ version: obsConfig.MANAGED_OBS_CONFIG_VERSION - 1 }), "utf8");
    await writeFile(path.join(runtimeRoot, "obsolete.txt"), "old configuration", "utf8");

    await prepareManagedObsRuntime(templateRoot, runtimeRoot, password);

    const marker = JSON.parse(await readFile(path.join(runtimeRoot, ".managed-version.json"), "utf8"));
    const configuration = JSON.parse(await readFile(obsConfig.managedObsWebSocketConfigPath(runtimeRoot), "utf8"));
    assert.equal(marker.version, obsConfig.MANAGED_OBS_CONFIG_VERSION);
    assert.equal(configuration.server_enabled, true);
    assert.equal(configuration.auth_required, true);
    assert.equal(configuration.server_port, 4455);
    assert.equal(digest(configuration.server_password), digest(password));
    await assert.rejects(readFile(path.join(runtimeRoot, "obsolete.txt")), { code: "ENOENT" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("managed OBS reuses the DPAPI-backed encrypted password across controller instances", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "managed-obs-secret-"));
  const secretPath = path.join(scratch, "managed-obs-password.bin");
  const generated = `generated-${process.pid}-${Date.now()}`;
  const { ManagedObsSecretStore } = await loadTypeScriptModule(
    new URL("../../desktop/obs-secret-store.ts", import.meta.url)
  );
  const protect = (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5);
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return protect(value); },
    async decryptStringAsync(value) {
      return { result: protect(value).toString("utf8"), shouldReEncrypt: false };
    }
  };
  try {
    const first = new ManagedObsSecretStore(secretPath, safeStorage, () => generated);
    const firstSecret = await first.loadOrCreate();
    const encrypted = await readFile(secretPath);
    const second = new ManagedObsSecretStore(secretPath, safeStorage, () => {
      throw new Error("an existing encrypted password must be recovered");
    });
    const recovered = await second.loadOrCreate();
    assert.equal(digest(firstSecret), digest(generated));
    assert.equal(digest(recovered), digest(generated));
    assert.equal(encrypted.includes(Buffer.from(generated)), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("renderer contract exposes bounded OBS control without connection secrets", async () => {
  const [manager, ipc, preload, types] = await Promise.all([
    readFile(new URL("../../desktop/managed-obs.ts", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/ipc.ts", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/preload.ts", import.meta.url), "utf8"),
    readFile(new URL("../../desktop/types.ts", import.meta.url), "utf8")
  ]);

  assert.match(manager, /MANAGED_OBS_STARTUP_TIMEOUT_MS = 30_000/);
  assert.match(manager, /listManagedObsProcesses/);
  assert.match(manager, /OBS_PORT_IN_USE/);
  for (const code of [
    "OBS_CONFIG_WRITE_FAILED",
    "OBS_PROCESS_EXITED",
    "OBS_PORT_NOT_READY",
    "OBS_AUTH_FAILED",
    "OBS_SCENE_CONFIG_FAILED",
    "OBS_VIRTUAL_CAMERA_FAILED"
  ]) assert.match(manager, new RegExp(code));

  const readyVariant = types.match(/\|\s*\{\s*status:\s*"ready";([^}]*)\}/s)?.[1] ?? "";
  assert.match(readyVariant, /version:\s*string/);
  assert.match(readyVariant, /virtualCameraActive:\s*boolean/);
  assert.doesNotMatch(readyVariant, /password|stageUrl|url:|port:/);

  for (const channel of [
    "desktop:ensure-managed-obs",
    "desktop:get-managed-obs-state",
    "desktop:set-managed-obs-virtual-camera",
    "desktop:set-managed-obs-intervention-routing",
    "desktop:stop-managed-obs",
    "desktop:reset-managed-obs-config"
  ]) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
  assert.match(ipc, /typeof\s+active\s*!==\s*"boolean"/);
  for (const action of ["begin", "end", "resume", "mute"]) assert.match(ipc, new RegExp(`"${action}"`));
  assert.match(ipc, /INVALID_OBS_VIRTUAL_CAMERA_STATE/);
  assert.match(ipc, /INVALID_OBS_INTERVENTION_ACTION/);

  assert.doesNotMatch(preload, /websocket_password|server_password/);
  assert.doesNotMatch(types, /password:\s*string/);
});

test("OBS IPC validates booleans and intervention actions before calling the manager", async () => {
  const handlers = new Map();
  const calls = [];
  const { registerDesktopIpc } = await loadTypeScriptModule(
    new URL("../../desktop/ipc.ts", import.meta.url),
    {
      electron: { shell: { async openExternal() {} } },
      "./audio/capture-process": { AudioCaptureProcess: class AudioCaptureProcess { start() {} stop() {} } },
      "./audio/meeting-processes": { async listMeetingProcesses() { return []; } },
      "./prerequisites/windows-install": {
        getPrerequisiteStatus() { return {}; },
        async installPrerequisite() { return { installed: true, rebootRequired: false }; }
      }
    }
  );
  const obsManager = {
    async ensure() { return { status: "idle" }; },
    async getState() { return { status: "idle" }; },
    async setVirtualCamera(active) { calls.push(["camera", active]); return { status: "idle" }; },
    async setInterventionRouting(action) { calls.push(["routing", action]); return { status: "idle" }; },
    async stop() { return { status: "stopped" }; },
    async reset() { return { status: "idle" }; }
  };
  registerDesktopIpc(
    { handle(channel, handler) { handlers.set(channel, handler); } },
    () => ({ ready: true, baseUrl: null, serverOwned: false }),
    () => null,
    "AudioBridge.exe",
    { scriptPath: "install.ps1", directory: "prerequisites" },
    obsManager
  );

  assert.throws(
    () => handlers.get("desktop:set-managed-obs-virtual-camera")({}, "true"),
    /INVALID_OBS_VIRTUAL_CAMERA_STATE/
  );
  assert.throws(
    () => handlers.get("desktop:set-managed-obs-intervention-routing")({}, "restart"),
    /INVALID_OBS_INTERVENTION_ACTION/
  );
  await handlers.get("desktop:set-managed-obs-virtual-camera")({}, true);
  for (const action of ["begin", "end", "resume", "mute"]) {
    await handlers.get("desktop:set-managed-obs-intervention-routing")({}, action);
  }
  assert.deepEqual(calls, [
    ["camera", true],
    ["routing", "begin"],
    ["routing", "end"],
    ["routing", "resume"],
    ["routing", "mute"]
  ]);
});

test("packaged OBS smoke supports explicit control and real modes without implicit UAC", async () => {
  const smoke = await readFile(new URL("../../scripts/test-packaged-runtime.mjs", import.meta.url), "utf8");
  assert.match(smoke, /AI_INTERVIEWER_PACKAGED_OBS_SMOKE/);
  assert.match(smoke, /obsSmokeMode === "control"/);
  assert.match(smoke, /obsSmokeMode === "real"/);
  assert.match(smoke, /server_enabled:\s*true/);
  assert.match(smoke, /auth_required:\s*true/);
  assert.match(smoke, /SetInputAudioMonitorType/);
  assert.match(smoke, /StartVirtualCam/);
  assert.doesNotMatch(smoke, /Start-Process|Verb RunAs|install-prerequisite/);
});

test("prerequisite status distinguishes bundled OBS from system camera registration", async () => {
  const types = await readFile(new URL("../../desktop/types.ts", import.meta.url), "utf8");
  for (const field of ["obsBundled", "virtualCameraRegistered", "virtualAudioInstalled", "virtualAudioDriverStaged"]) {
    assert.match(types, new RegExp(`${field}:\\s*boolean`));
  }
  assert.doesNotMatch(types, /obsInstalled:\s*boolean/);
});

test("packaging uses the pinned official portable release", async () => {
  const manifest = await readFile(new URL("../../desktop/prerequisites/manifest.ts", import.meta.url), "utf8");
  const fetcher = await readFile(new URL("../../scripts/fetch-prerequisites.ps1", import.meta.url), "utf8");
  assert.match(manifest, /OBS-Studio-32\.2\.1-Windows-x64\.zip/);
  assert.match(manifest, /db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de/i);
  assert.match(fetcher, /portable_mode\.txt/);
  assert.match(fetcher, /OBS Project/);
});
