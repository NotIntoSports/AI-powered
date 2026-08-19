import type { VirtualAudioRoute } from "./audio-devices";

export const VIRTUAL_AUDIO_ROUTE_KEY = "ai-digital-human:virtual-audio-route:v1";

export type StoredVirtualAudioRoute = Pick<
  VirtualAudioRoute,
  "provider" | "label" | "input" | "output" | "inputDeviceId" | "outputDeviceId"
>;

function isStoredRoute(value: unknown): value is StoredVirtualAudioRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["provider", "label", "input", "output", "inputDeviceId", "outputDeviceId"]
    .every((key) => typeof record[key] === "string" && String(record[key]).trim());
}

export function loadVirtualAudioRoute(): StoredVirtualAudioRoute | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VIRTUAL_AUDIO_ROUTE_KEY) || "null");
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
}
