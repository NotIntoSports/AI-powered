import assert from "node:assert/strict";
import test from "node:test";

const { loadVirtualAudioRoute, resolvePreferredVirtualAudioRoute, resolveStoredRouteAgainstDevices } = await import(
  "../../features/audio/virtual-audio-route.ts"
);

const stored = {
  provider: "vb-cable",
  label: "VB-CABLE",
  input: "CABLE Output (VB-Audio Virtual Cable)",
  output: "CABLE Input (VB-Audio Virtual Cable)",
  inputDeviceId: "stored-input-id",
  outputDeviceId: "stored-output-id",
  verifiedAt: 1_000_000
};

test("resolves a stored route by label against current devices", () => {
  const devices = [
    { kind: "audioinput", label: "桌面麦克风", deviceId: "real-mic" },
    { kind: "audioinput", label: "CABLE Output (VB-Audio Virtual Cable)", deviceId: "new-input-id" },
    { kind: "audiooutput", label: " cABLE INPUT (VB-Audio Virtual Cable) ", deviceId: "new-output-id" },
    { kind: "audiooutput", label: "扬声器 (Realtek)", deviceId: "real-speaker" }
  ];
  const resolved = resolveStoredRouteAgainstDevices(stored, devices);
  assert.deepEqual(resolved, {
    provider: "vb-cable",
    label: "VB-CABLE",
    input: "CABLE Output (VB-Audio Virtual Cable)",
    output: " cABLE INPUT (VB-Audio Virtual Cable) ",
    inputDeviceId: "new-input-id",
    outputDeviceId: "new-output-id"
  });
});

test("migrates a stored 16-channel VB-CABLE route to the standard stereo endpoint", () => {
  const legacy16 = { ...stored, output: "CABLE In 16ch (VB-Audio Virtual Cable)" };
  const devices = [
    { kind: "audioinput", label: legacy16.input, deviceId: "input" },
    { kind: "audiooutput", label: legacy16.output, deviceId: "output-16" },
    { kind: "audiooutput", label: stored.output, deviceId: "output-stereo" },
  ];
  const resolved = resolvePreferredVirtualAudioRoute(legacy16, devices);
  assert.equal(resolved?.output, stored.output);
  assert.equal(resolved?.outputDeviceId, "output-stereo");
});

test("returns null when either endpoint label is missing", () => {
  const onlyInput = [
    { kind: "audioinput", label: "CABLE Output (VB-Audio Virtual Cable)", deviceId: "new-input-id" }
  ];
  assert.equal(resolveStoredRouteAgainstDevices(stored, onlyInput), null);
  assert.equal(resolveStoredRouteAgainstDevices(stored, []), null);
});

test("ignores default or missing device ids", () => {
  const devices = [
    { kind: "audioinput", label: "CABLE Output (VB-Audio Virtual Cable)", deviceId: "default" },
    { kind: "audiooutput", label: "CABLE Input (VB-Audio Virtual Cable)", deviceId: "" }
  ];
  assert.equal(resolveStoredRouteAgainstDevices(stored, devices), null);
});

test("route loading is a no-op outside the browser", () => {
  assert.equal(loadVirtualAudioRoute(), null);
});
