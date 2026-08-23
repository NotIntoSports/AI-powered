const LOCAL_AI_MONITOR_KEY = "ai-local-ai-monitor-enabled";
const LOCAL_AI_MONITOR_EVENT = "ai-local-ai-monitor-change";

/** Default ON so the operator can verify the AI content, voice, and tone. */
export function parseLocalAiMonitorEnabled(raw: string | null): boolean {
  if (raw === null) return true;
  return raw === "1" || raw === "true";
}

export function loadLocalAiMonitorEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return parseLocalAiMonitorEnabled(window.localStorage.getItem(LOCAL_AI_MONITOR_KEY));
  } catch {
    return true;
  }
}

export function saveLocalAiMonitorEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_AI_MONITOR_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore quota and private-mode failures; the in-page event still applies the choice.
  }
  window.dispatchEvent(new CustomEvent(LOCAL_AI_MONITOR_EVENT, { detail: { enabled } }));
}

export function subscribeLocalAiMonitor(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_AI_MONITOR_KEY || event.key === null) listener();
  };
  const onCustom = () => listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCAL_AI_MONITOR_EVENT, onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_AI_MONITOR_EVENT, onCustom);
  };
}
