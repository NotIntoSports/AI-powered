import { parseSubtitleInput, type SubtitleInput, type SubtitleLine } from "./contract.ts";
export type { SubtitleLine, SubtitleInput };
import { mergeSubtitle } from "./merge.ts";

export type SubtitleListener = (lines: SubtitleLine[]) => void;
export type FinalSubtitleListener = (line: SubtitleLine) => void;

export type SubtitleSink = {
  publish(input: SubtitleInput | unknown): void;
  subscribe(listener: SubtitleListener): () => void;
  subscribeFinal(listener: FinalSubtitleListener): () => void;
  reset(sessionId?: string): void;
  snapshot(): SubtitleLine[];
};

const maxLines = 200;

export function createSubtitleSink(defaultLanguage = "zh"): SubtitleSink {
  let lines: SubtitleLine[] = [];
  const listeners = new Set<SubtitleListener>();
  const finalListeners = new Set<FinalSubtitleListener>();

  function notify() {
    const snapshot = lines.slice();
    for (const listener of listeners) listener(snapshot);
  }

  return {
    publish(input) {
      const parsed = parseSubtitleInput(input);
      if (!parsed.ok) return;
      const previous = lines.find((item) =>
        item.sessionId === parsed.value.sessionId && item.utteranceId === parsed.value.utteranceId
      );
      lines = mergeSubtitle(lines, parsed.value, Date.now(), defaultLanguage).slice(-maxLines);
      notify();
      const next = lines.find((item) =>
        item.sessionId === parsed.value.sessionId && item.utteranceId === parsed.value.utteranceId
      );
      if (next?.final && !previous?.final) {
        for (const listener of finalListeners) listener(next);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(lines.slice());
      return () => { listeners.delete(listener); };
    },
    subscribeFinal(listener) {
      finalListeners.add(listener);
      return () => { finalListeners.delete(listener); };
    },
    reset(sessionId) {
      lines = sessionId
        ? lines.filter((item) => item.sessionId !== sessionId)
        : [];
      notify();
    },
    snapshot() {
      return lines.slice();
    }
  };
}

export const subtitleSink = createSubtitleSink();
