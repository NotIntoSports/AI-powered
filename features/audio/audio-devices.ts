export type AudioDeviceCandidate = {
  kind: "audioinput" | "audiooutput";
  label: string;
  deviceId?: string;
};

export type VirtualAudioRoute = {
  provider: "vb-cable" | "virtual-audio-driver" | "voicemeeter";
  label: string;
  input: string;
  output: string;
  inputDeviceId: string;
  outputDeviceId: string;
};

const cableProfiles = ["", "-A", "-B", "-C", "-D"].map((suffix) => ({
  provider: "vb-cable" as const,
  label: suffix ? `VB-CABLE${suffix}` : "VB-CABLE",
  input: new RegExp(`\\bcable${suffix}\\s+output\\b`, "i"),
  output: new RegExp(`\\bcable${suffix}\\s+input\\b`, "i")
}));

const routeProfiles: Array<{
  provider: VirtualAudioRoute["provider"];
  label: string;
  input: RegExp;
  output: RegExp;
}> = [
  ...cableProfiles,
  {
    provider: "virtual-audio-driver",
    label: "Virtual Audio Driver",
    input: /virtual\s+(?:mic|microphone)(?:\s+driver)?/i,
    output: /virtual\s+audio(?:\s+driver)?/i
  },
  {
    provider: "voicemeeter",
    label: "Voicemeeter",
    input: /voicemeeter(?:\s+(?:aux|vaio3))?\s+output/i,
    output: /voicemeeter(?:\s+(?:aux|vaio3))?\s+input/i
  }
];

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function classifyAudioDevices(devices: AudioDeviceCandidate[]) {
  const inputDevices = devices.filter(
    (device) => device.kind === "audioinput" && device.deviceId !== "default"
  );
  const outputDevices = devices.filter(
    (device) => device.kind === "audiooutput" && device.deviceId !== "default"
  );
  const inputs = unique(inputDevices.map((device) => device.label || "未命名录音设备"));
  const outputs = unique(outputDevices.map((device) => device.label || "未命名播放设备"));
  const routes = routeProfiles.flatMap((profile) => {
    const input = inputDevices.find((device) => profile.input.test(device.label));
    const output = outputDevices.find((device) => profile.output.test(device.label));
    return input?.deviceId && output?.deviceId ? [{
      provider: profile.provider,
      label: profile.label,
      input: input.label,
      output: output.label,
      inputDeviceId: input.deviceId,
      outputDeviceId: output.deviceId
    } satisfies VirtualAudioRoute] : [];
  });
  const ignoredRemoteAudio = unique(
    [...inputs, ...outputs].filter((name) => /todesk|sunshine|parsec|remote desktop/i.test(name))
  );

  return {
    inputs,
    outputs,
    routes,
    virtualInputs: unique(routes.map((route) => route.input)),
    virtualOutputs: unique(routes.map((route) => route.output)),
    ignoredRemoteAudio
  };
}

const unwantedCloneMicrophone = /vb-audio|cable\s+(?:output|input)|voicemeeter|virtual\s+(?:mic|microphone|audio)|todesk|sunshine|parsec|remote desktop/i;

export function isUnwantedCloneMicrophone(label: string) {
  return unwantedCloneMicrophone.test(label);
}

export function pickCloneMicrophone(devices: AudioDeviceCandidate[]) {
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
  return inputs.find((device) => !isUnwantedCloneMicrophone(device.label)) || null;
}
