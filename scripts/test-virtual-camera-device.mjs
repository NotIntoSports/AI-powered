import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/obs/virtual-camera-device.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { findObsVirtualCamera, stopMediaStream } = await import(moduleUrl);

assert.deepEqual(findObsVirtualCamera([
  { kind: "audioinput", label: "OBS Virtual Camera", deviceId: "wrong-kind" },
  { kind: "videoinput", label: "Integrated Camera", deviceId: "physical" },
  { kind: "videoinput", label: "OBS Virtual Camera", deviceId: "obs-camera" }
]), {
  kind: "videoinput",
  label: "OBS Virtual Camera",
  deviceId: "obs-camera"
});
assert.equal(findObsVirtualCamera([
  { kind: "videoinput", label: "", deviceId: "hidden-label" },
  { kind: "videoinput", label: "Integrated Camera", deviceId: "physical" }
]), null);
assert.equal(findObsVirtualCamera([
  { kind: "videoinput", label: "OBS Virtual Camera", deviceId: "" }
]), null);
let stoppedTracks = 0;
stopMediaStream({
  getTracks: () => [
    { stop: () => { stoppedTracks += 1; } },
    { stop: () => { stoppedTracks += 1; } }
  ]
});
assert.equal(stoppedTracks, 2);
stopMediaStream(null);

process.stdout.write("virtual camera device classification test passed\n");
