export const OUTPUT_MODE_KEY = "ai-digital-human:output-mode";
export const OUTPUT_MODE_CHANGE_EVENT = "ai-digital-human:output-mode";
export const DEFAULT_OUTPUT_MODE = "real" as const;

export type OutputMode = "real" | "virtual";

export function parseOutputMode(value: string | null | undefined): OutputMode {
  return value === "virtual" ? "virtual" : DEFAULT_OUTPUT_MODE;
}

export function loadOutputMode(): OutputMode {
  if (typeof window === "undefined") return DEFAULT_OUTPUT_MODE;
  return parseOutputMode(window.localStorage.getItem(OUTPUT_MODE_KEY));
}

export function saveOutputMode(mode: OutputMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(OUTPUT_MODE_KEY, mode);
  window.dispatchEvent(new Event(OUTPUT_MODE_CHANGE_EVENT));
}

export function subscribeOutputMode(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === OUTPUT_MODE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(OUTPUT_MODE_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(OUTPUT_MODE_CHANGE_EVENT, listener);
  };
}
