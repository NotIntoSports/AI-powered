import { classifyAudioDevices, type AudioDeviceCandidate, type VirtualAudioRoute } from "./audio-devices.ts";

export const VIRTUAL_AUDIO_ROUTE_KEY = "ai-digital-human:virtual-audio-route:v2";
const LEGACY_VIRTUAL_AUDIO_ROUTE_KEY = "ai-digital-human:virtual-audio-route:v1";

export type StoredVirtualAudioRoute = Pick<
  VirtualAudioRoute,
  "provider" | "label" | "input" | "output" | "inputDeviceId" | "outputDeviceId"
> & { verifiedAt?: number };

function isStoredRoute(value: unknown): value is StoredVirtualAudioRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fieldsOk = ["provider", "label", "input", "output", "inputDeviceId", "outputDeviceId"]
    .every((key) => typeof record[key] === "string" && String(record[key]).trim());
  const verifiedAtOk = record.verifiedAt === undefined ||
    (typeof record.verifiedAt === "number" && Number.isFinite(record.verifiedAt) && record.verifiedAt > 0);
  return fieldsOk && verifiedAtOk;
}

export function loadVirtualAudioRoute(): StoredVirtualAudioRoute | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(VIRTUAL_AUDIO_ROUTE_KEY) ||
      window.localStorage.getItem(LEGACY_VIRTUAL_AUDIO_ROUTE_KEY) ||
      "null"
    );
    return isStoredRoute(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveVirtualAudioRoute(route: StoredVirtualAudioRoute) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VIRTUAL_AUDIO_ROUTE_KEY, JSON.stringify(route));
}

export function clearVirtualAudioRoute() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(VIRTUAL_AUDIO_ROUTE_KEY);
  window.localStorage.removeItem(LEGACY_VIRTUAL_AUDIO_ROUTE_KEY);
}

function normalizeLabel(label: string) {
  return label.trim().toLowerCase();
}

// Chromium deviceIds are stable per origin but labels are the human-facing truth;
// re-resolve a stored route against the current device list by label so a saved
// route survives restarts and device list churn.
export function resolveStoredRouteAgainstDevices(
  stored: StoredVirtualAudioRoute,
  devices: AudioDeviceCandidate[]
): VirtualAudioRoute | null {
  const wantedInput = normalizeLabel(stored.input);
  const wantedOutput = normalizeLabel(stored.output);
  const input = devices.find(
    (device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" &&
      normalizeLabel(device.label) === wantedInput
  );
  const output = devices.find(
    (device) => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default" &&
      normalizeLabel(device.label) === wantedOutput
  );
  if (!input?.deviceId || !output?.deviceId) return null;
  return {
    provider: stored.provider,
    label: stored.label,
    input: input.label,
    output: output.label,
    inputDeviceId: input.deviceId,
    outputDeviceId: output.deviceId
  };
}

// Old clients could persist the first enumerated VB-CABLE playback endpoint,
// which is commonly the 16-channel endpoint. Prefer the standard stereo cable
// when it is present, while keeping the stored recording side/profile fixed.
export function resolvePreferredVirtualAudioRoute(
  stored: StoredVirtualAudioRoute,
  devices: AudioDeviceCandidate[]
): VirtualAudioRoute | null {
  const resolvedStored = resolveStoredRouteAgainstDevices(stored, devices);
  if (stored.provider !== "vb-cable" || stored.label !== "VB-CABLE") return resolvedStored;

  const wantedInput = normalizeLabel(stored.input);
  const preferred = classifyAudioDevices(devices).routes.find((route) =>
    route.provider === "vb-cable" &&
    route.label === "VB-CABLE" &&
    normalizeLabel(route.input) === wantedInput
  );
  return preferred || resolvedStored;
}
