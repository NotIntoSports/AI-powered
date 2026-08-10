import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/obs/obs-service.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const {
  OBS_INPUT_NAME,
  OBS_HUMAN_MIC_NAME,
  OBS_SCENE_NAME,
  configureObs,
  retryUntilSuccess,
  setInterventionRouting,
  startVirtualCamera,
  stopVirtualCamera
} = await import(moduleUrl);

class FakeObs {
  constructor({ sceneExists = false, inputExists = false, itemExists = false, cameraActive = false } = {}) {
    this.sceneExists = sceneExists;
    this.inputExists = inputExists;
    this.itemExists = itemExists;
    this.cameraActive = cameraActive;
    this.calls = [];
  }

  async call(requestType, requestData) {
    this.calls.push({ requestType, requestData });
    if (requestType === "GetSceneList") {
      return { scenes: this.sceneExists ? [{ sceneName: OBS_SCENE_NAME }] : [] };
    }
    if (requestType === "CreateScene") {
      this.sceneExists = true;
      return {};
    }
    if (requestType === "GetInputList") {
      return { inputs: this.inputExists ? [{ inputName: OBS_INPUT_NAME, inputKind: "browser_source" }] : [] };
    }
    if (requestType === "CreateInput") {
      this.inputExists = true;
      this.itemExists = true;
      return { sceneItemId: 42 };
    }
    if (requestType === "GetSceneItemId") {
      if (!this.itemExists) throw new Error("scene item missing");
      return { sceneItemId: 42 };
    }
    if (requestType === "CreateSceneItem") {
      this.itemExists = true;
      return { sceneItemId: 42 };
    }
    if (requestType === "GetVirtualCamStatus") {
      return { outputActive: this.cameraActive };
    }
    if (requestType === "StartVirtualCam") {
      this.cameraActive = true;
      return {};
    }
    if (requestType === "StopVirtualCam") {
      this.cameraActive = false;
      return {};
    }
    return {};
  }
}

const fresh = new FakeObs();
const freshResult = await configureObs(fresh, "http://localhost:3000/stage");
assert.deepEqual(freshResult, {
  sceneCreated: true,
  inputCreated: true,
    audioMonitoringEnabled: true,
  virtualCameraStarted: true,
  humanMicReady: true
});
assert.equal(fresh.cameraActive, true);
assert.ok(fresh.calls.some((call) => call.requestType === "CreateScene"));
assert.ok(fresh.calls.some((call) => call.requestType === "CreateInput"));
assert.ok(fresh.calls.some((call) => call.requestType === "SetVideoSettings"));
assert.ok(fresh.calls.some((call) => call.requestType === "SetSceneItemTransform"));
assert.ok(fresh.calls.some((call) => call.requestType === "SetCurrentProgramScene"));
assert.ok(fresh.calls.some((call) =>
  call.requestType === "SetInputAudioMonitorType" &&
  call.requestData.monitorType === "OBS_MONITORING_TYPE_MONITOR_ONLY"
));

const existing = new FakeObs({
  sceneExists: true,
  inputExists: true,
  itemExists: true,
  cameraActive: true
});
const existingResult = await configureObs(existing, "http://localhost:3000/stage");
assert.deepEqual(existingResult, {
  sceneCreated: false,
  inputCreated: false,
    audioMonitoringEnabled: true,
  virtualCameraStarted: false,
  humanMicReady: true
});
assert.ok(existing.calls.some((call) => call.requestType === "SetInputSettings"));
assert.equal(existing.calls.some((call) => call.requestType === "CreateScene"), false);
assert.equal(existing.calls.some((call) => call.requestType === "CreateInput" && call.requestData.inputName === OBS_INPUT_NAME), false);
assert.ok(existing.calls.some((call) => call.requestType === "CreateInput" && call.requestData.inputName === OBS_HUMAN_MIC_NAME));
assert.equal(existing.calls.some((call) => call.requestType === "SetVideoSettings"), false);

await setInterventionRouting(existing, "begin");
assert.ok(existing.calls.some((call) => call.requestType === "SetInputMute" && call.requestData.inputName === OBS_HUMAN_MIC_NAME && call.requestData.inputMuted === false));
await setInterventionRouting(existing, "end");
assert.ok(existing.calls.some((call) => call.requestType === "SetInputMute" && call.requestData.inputName === OBS_INPUT_NAME && call.requestData.inputMuted === true));
await setInterventionRouting(existing, "resume");
assert.ok(existing.calls.some((call) => call.requestType === "SetInputMute" && call.requestData.inputName === OBS_INPUT_NAME && call.requestData.inputMuted === false));

await stopVirtualCamera(existing);
assert.equal(existing.cameraActive, false);
await startVirtualCamera(existing);
assert.equal(existing.cameraActive, true);

let coldStartAttempts = 0;
const coldStartConnected = await retryUntilSuccess(
  async () => {
    coldStartAttempts += 1;
    return coldStartAttempts === 3;
  },
  { attempts: 5, delayMs: 0 }
);
assert.equal(coldStartConnected, true);
assert.equal(coldStartAttempts, 3);

let exhaustedAttempts = 0;
const exhausted = await retryUntilSuccess(
  async () => {
    exhaustedAttempts += 1;
    throw new Error("OBS not ready");
  },
  { attempts: 4, delayMs: 0 }
);
assert.equal(exhausted, false);
assert.equal(exhaustedAttempts, 4);

let cancelled = false;
let cancelledAttempts = 0;
const cancelledResult = await retryUntilSuccess(
  async () => {
    cancelledAttempts += 1;
    return false;
  },
  {
    attempts: 10,
    delayMs: 0,
    isCancelled: () => cancelled,
    onRetry: () => {
      cancelled = true;
    }
  }
);
assert.equal(cancelledResult, false);
assert.equal(cancelledAttempts, 1);

process.stdout.write("OBS service test passed\n");
