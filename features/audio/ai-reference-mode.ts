const AI_REFERENCE_MODE_KEY = "ai-reference-mode-enabled";
const AI_REFERENCE_MODE_EVENT = "ai-reference-mode-change";

/** Default OFF: normal mode continues sending AI speech to the virtual microphone. */
export function parseAiReferenceModeEnabled(raw: string | null): boolean {
  if (raw === null) return false;
  return raw === "1" || raw === "true";
}

export function loadAiReferenceModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseAiReferenceModeEnabled(window.localStorage.getItem(AI_REFERENCE_MODE_KEY));
  } catch {
    return false;
  }
}

export function saveAiReferenceModeEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_REFERENCE_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // The in-page event still applies the choice when persistence is unavailable.
  }
  window.dispatchEvent(new CustomEvent(AI_REFERENCE_MODE_EVENT, { detail: { enabled } }));
}

export function subscribeAiReferenceMode(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === AI_REFERENCE_MODE_KEY || event.key === null) listener();
  };
  const onCustom = () => listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener(AI_REFERENCE_MODE_EVENT, onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(AI_REFERENCE_MODE_EVENT, onCustom);
  };
}
