import type { SubtitleLine } from "../../lib/subtitles/contract.ts";

export type SubtitleTimelineStatus = "idle" | "running" | "finished";

export function selectTimelineSubtitleLines(input: {
  lines: SubtitleLine[];
  status: SubtitleTimelineStatus;
  finishedAt?: string | null;
  limit?: number;
}): SubtitleLine[] {
  const limit = Math.max(1, input.limit ?? 20);
  if (input.status === "running") {
    return input.lines.filter((line) => !line.final).slice(-1);
  }
  if (input.status === "finished") {
    const finishedAt = input.finishedAt ? Date.parse(input.finishedAt) : Number.NaN;
    if (Number.isNaN(finishedAt)) return [];
    return input.lines.filter((line) => line.receivedAt > finishedAt).slice(-limit);
  }
  return input.lines.slice(-limit);
}
