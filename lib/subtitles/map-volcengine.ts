import type { SubtitleInput } from "./contract.ts";

export type VolcengineSubtitleMessage = {
  userId?: string;
  sequence?: number | string;
  text?: string;
  definite?: boolean;
  language?: string;
};

export function mapVolcengineSubtitles(
  payload: unknown,
  sessionId: string,
  language = "zh"
): SubtitleInput[] {
  const messages = Array.isArray(payload) ? payload : payload == null ? [] : [payload];
  const mapped: SubtitleInput[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const value = message as VolcengineSubtitleMessage;
    if (typeof value.text !== "string" || !value.text.trim()) continue;
    if (value.sequence == null || value.sequence === "") continue;
    mapped.push({
      v: 1,
      sessionId,
      speaker: "candidate",
      utteranceId: String(value.sequence),
      text: value.text.trim(),
      final: value.definite === true,
      language: typeof value.language === "string" && value.language.trim() ? value.language.trim() : language,
      emittedAt: new Date().toISOString(),
      source: "volcengine"
    });
  }
  return mapped;
}
