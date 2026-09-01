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

export type UnpairedVirtualInput = {
  provider: VirtualAudioRoute["provider"];
  label: string;
  input: string;
  inputDeviceId: string;
};

const cableProfiles = ["", "-A", "-B", "-C", "-D"].map((suffix) => ({
  provider: "vb-cable" as const,
  label: suffix ? `VB-CABLE${suffix}` : "VB-CABLE",
  input: new RegExp(
    suffix === ""
      ? "\\bcable\\s+output\\b|麦克风\\s*\\([^)]*VB-Audio[^)]*\\)"
      : `\\bcable${suffix}\\s+output\\b`,
    "i"
  ),
  output: new RegExp(
    suffix === ""
      ? "\\bcable\\s+in(?:put)?\\b|扬声器\\s*\\([^)]*VB-Audio[^)]*\\)"
      : `\\bcable${suffix}\\s+in(?:put)?\\b`,
    "i"
  )
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
    input: /virtual\s+(?:mic|microphone)(?:\s+driver)?|(?:麦克风|microphone)\s*\([^)]*virtual\s+audio/i,
    output: /virtual\s+audio(?:\s+driver)?|(?:扬声器|speakers?)\s*\([^)]*virtual\s+audio/i
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

function isRemoteAudio(label: string) {
  return /todesk|sunshine|parsec|remote desktop/i.test(label);
}

function pickProfileOutput(
  profile: (typeof routeProfiles)[number],
  devices: AudioDeviceCandidate[]
) {
  const matches = devices.filter(
    (device) => !isRemoteAudio(device.label) && profile.output.test(device.label)
  );
  if (profile.provider === "vb-cable" && profile.label === "VB-CABLE") {
    return matches.find((device) => /\bcable\s+input\b/i.test(device.label)) || matches[0];
  }
  return matches[0];
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
    const input = inputDevices.find((device) => !isRemoteAudio(device.label) && profile.input.test(device.label));
    const output = pickProfileOutput(profile, outputDevices);
    return input?.deviceId && output?.deviceId ? [{
      provider: profile.provider,
      label: profile.label,
      input: input.label,
      output: output.label,
      inputDeviceId: input.deviceId,
      outputDeviceId: output.deviceId
    } satisfies VirtualAudioRoute] : [];
  });
  const routedInputIds = new Set(routes.map((route) => route.inputDeviceId));
  const unpairedVirtualInputs = routeProfiles.flatMap((profile) => {
    const input = inputDevices.find((device) => !isRemoteAudio(device.label) && profile.input.test(device.label));
    if (!input?.deviceId || routedInputIds.has(input.deviceId)) return [];
    return [{
      provider: profile.provider,
      label: profile.label,
      input: input.label,
      inputDeviceId: input.deviceId
    } satisfies UnpairedVirtualInput];
  });
  const unlabeledOutputs = outputDevices.filter((device) => device.deviceId && !device.label.trim());
  const ignoredRemoteAudio = unique(
    [...inputs, ...outputs].filter((name) => isRemoteAudio(name))
  );

  return {
    inputs,
    outputs,
    routes,
    unpairedVirtualInputs,
    unlabeledOutputs: unlabeledOutputs.map((device) => ({
      label: device.label,
      deviceId: device.deviceId as string
    })),
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
