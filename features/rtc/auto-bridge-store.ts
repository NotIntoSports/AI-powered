import { MEETING_EXECUTABLE_NAMES } from "../../desktop/audio/meeting-processes.ts";

export { MEETING_EXECUTABLE_NAMES };
export { MEETING_SOFTWARE_LABELS } from "../../desktop/audio/meeting-processes.ts";

const ENABLED_KEY = "ai-auto-bridge-enabled";
const SOFTWARE_KEY = "ai-auto-bridge-software";
const CHANGE_EVENT = "ai-auto-bridge-change";

export function parseAutoBridgeEnabled(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

export function parseAutoBridgeSoftware(raw: string | null): string {
  const value = (raw || "").trim().toLowerCase();
  return MEETING_EXECUTABLE_NAMES.has(value) ? value : "";
}

export function loadAutoBridgeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseAutoBridgeEnabled(window.localStorage.getItem(ENABLED_KEY));
  } catch {
    return false;
  }
}

export function loadAutoBridgeSoftware(): string {
  if (typeof window === "undefined") return "";
  try {
    return parseAutoBridgeSoftware(window.localStorage.getItem(SOFTWARE_KEY));
  } catch {
    return "";
  }
}

export function saveAutoBridgeEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function saveAutoBridgeSoftware(software: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOFTWARE_KEY, parseAutoBridgeSoftware(software));
  } catch {
    // ignore quota / private mode
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeAutoBridgeStore(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === ENABLED_KEY || event.key === SOFTWARE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
