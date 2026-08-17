const REMOTE_MONITOR_KEY = "ai-remote-monitor-enabled";
const REMOTE_MONITOR_EVENT = "ai-remote-monitor-change";

/** Default ON: operator needs to hear the other party before deciding to interrupt AI. */
export function parseRemoteMonitorEnabled(raw: string | null): boolean {
  if (raw === null) return true;
  return raw === "1" || raw === "true";
}

export function loadRemoteMonitorEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return parseRemoteMonitorEnabled(window.localStorage.getItem(REMOTE_MONITOR_KEY));
  } catch {
    return true;
  }
}

export function saveRemoteMonitorEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMOTE_MONITOR_KEY, enabled ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  window.dispatchEvent(new CustomEvent(REMOTE_MONITOR_EVENT, { detail: { enabled } }));
}

export function subscribeRemoteMonitor(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === REMOTE_MONITOR_KEY || event.key === null) listener();
  };
  const onCustom = () => listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener(REMOTE_MONITOR_EVENT, onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REMOTE_MONITOR_EVENT, onCustom);
  };
}
