import type { SubtitleInput, SubtitleLine } from "./contract.ts";

export function mergeSubtitle(
  state: SubtitleLine[],
  event: SubtitleInput,
  receivedAt = Date.now(),
  defaultLanguage = "zh"
): SubtitleLine[] {
  const existing = state.find((item) =>
    item.sessionId === event.sessionId && item.utteranceId === event.utteranceId
  );
  if (existing?.final && !event.final) return state;
  const next: SubtitleLine = {
    sessionId: event.sessionId,
    speaker: event.speaker || "candidate",
    utteranceId: event.utteranceId,
    text: event.text,
    final: event.final,
    language: event.language || existing?.language || defaultLanguage,
    emittedAt: event.emittedAt || existing?.emittedAt,
    receivedAt: existing?.final ? existing.receivedAt : receivedAt,
    source: event.source || existing?.source
  };
  return [
    ...state.filter((item) =>
      item.sessionId !== event.sessionId || item.utteranceId !== event.utteranceId
    ),
    next
  ].sort(compareSubtitleLines);
}

export function compareSubtitleLines(left: SubtitleLine, right: SubtitleLine): number {
  const leftEmitted = emittedMillis(left);
  const rightEmitted = emittedMillis(right);
  if (leftEmitted !== rightEmitted) return leftEmitted - rightEmitted;
  if (left.receivedAt !== right.receivedAt) return left.receivedAt - right.receivedAt;
  return left.utteranceId.localeCompare(right.utteranceId);
}

function emittedMillis(line: SubtitleLine): number {
  if (!line.emittedAt) return line.receivedAt;
  const parsed = Date.parse(line.emittedAt);
  return Number.isNaN(parsed) ? line.receivedAt : parsed;
}
