import { MEETING_EXECUTABLE_NAMES } from "../../desktop/audio/meeting-software.ts";

export { MEETING_EXECUTABLE_NAMES };
export { MEETING_SOFTWARE_LABELS } from "../../desktop/audio/meeting-software.ts";

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

/**
 * 选择即武装：一次性写入预选软件并开启自动听取（白名单外的值会先被归一化为空串）。
 * 主页面「会议接入」卡片使用；返回武装后的软件值，便于调用方回显。
 */
export function armAutoBridge(software: string): string {
  if (typeof window === "undefined") return "";
  const parsed = parseAutoBridgeSoftware(software);
  try {
    window.localStorage.setItem(SOFTWARE_KEY, parsed);
    window.localStorage.setItem(ENABLED_KEY, parsed ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  return parsed;
}

/** 解除武装：关闭自动听取并清空预选软件（用户主动选择"未选择"时使用）。 */
export function disarmAutoBridge() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOFTWARE_KEY, "");
    window.localStorage.setItem(ENABLED_KEY, "0");
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
