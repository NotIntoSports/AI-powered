import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/audio/audio-devices.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { classifyAudioDevices } = await import(moduleUrl);

const toDesk = classifyAudioDevices([
  { kind: "audioinput", label: "默认 - 麦克风", deviceId: "default" },
  { kind: "audioinput", label: "麦克风 (ToDesk Virtual Audio)", deviceId: "mic-1" },
  { kind: "audiooutput", label: "扬声器 (ToDesk Virtual Audio)", deviceId: "speaker-1" },
  { kind: "audiooutput", label: "扬声器 (ToDesk Virtual Audio)", deviceId: "speaker-duplicate" }
]);
assert.deepEqual(toDesk.routes, []);
assert.deepEqual(toDesk.virtualInputs, []);
assert.deepEqual(toDesk.virtualOutputs, []);
assert.deepEqual(toDesk.ignoredRemoteAudio, [
  "麦克风 (ToDesk Virtual Audio)",
  "扬声器 (ToDesk Virtual Audio)"
]);
assert.equal(toDesk.inputs.includes("默认 - 麦克风"), false);

const vbCable = classifyAudioDevices([
  { kind: "audioinput", label: "CABLE Output (VB-Audio Virtual Cable)", deviceId: "cable-out" },
  { kind: "audiooutput", label: "CABLE Input (VB-Audio Virtual Cable)", deviceId: "cable-in" },
  { kind: "audioinput", label: "Realtek Microphone", deviceId: "real-mic" }
]);
assert.deepEqual(vbCable.virtualInputs, ["CABLE Output (VB-Audio Virtual Cable)"]);
assert.deepEqual(vbCable.virtualOutputs, ["CABLE Input (VB-Audio Virtual Cable)"]);
assert.deepEqual(vbCable.routes, [{
  provider: "vb-cable",
  label: "VB-CABLE",
  input: "CABLE Output (VB-Audio Virtual Cable)",
  output: "CABLE Input (VB-Audio Virtual Cable)",
  inputDeviceId: "cable-out",
  outputDeviceId: "cable-in"
}]);
assert.deepEqual(vbCable.inputs, [
  "CABLE Output (VB-Audio Virtual Cable)",
  "Realtek Microphone"
]);

const incomplete = classifyAudioDevices([
  { kind: "audioinput", label: "Virtual Microphone", deviceId: "virtual-mic" },
  { kind: "audiooutput", label: "Realtek Speakers", deviceId: "real-speaker" }
]);
assert.equal(incomplete.virtualInputs.length, 0);
assert.equal(incomplete.virtualOutputs.length, 0);
assert.equal(incomplete.routes.length, 0);

const openSourceDriver = classifyAudioDevices([
  { kind: "audioinput", label: "Virtual Mic Driver", deviceId: "virtual-mic" },
  { kind: "audiooutput", label: "Virtual Audio Driver", deviceId: "virtual-speaker" }
]);
assert.deepEqual(openSourceDriver.routes, [{
  provider: "virtual-audio-driver",
  label: "Virtual Audio Driver",
  input: "Virtual Mic Driver",
  output: "Virtual Audio Driver",
  inputDeviceId: "virtual-mic",
  outputDeviceId: "virtual-speaker"
}]);

const mismatchedCable = classifyAudioDevices([
  { kind: "audioinput", label: "CABLE-A Output", deviceId: "cable-a-out" },
  { kind: "audiooutput", label: "CABLE-B Input", deviceId: "cable-b-in" }
]);
assert.deepEqual(mismatchedCable.routes, []);

process.stdout.write("audio device classification test passed\n");
