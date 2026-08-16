import { parseSubtitleInput, type SubtitleInput } from "./contract.ts";

export type LiveKitTranscriptionSegment = {
  id?: string;
  text?: string;
  final?: boolean;
  language?: string;
  startTime?: number;
  endTime?: number;
};

export function mapLiveKitSegment(
  segment: LiveKitTranscriptionSegment,
  sessionId: string,
  language = "zh"
): SubtitleInput | null {
  if (!segment.id || typeof segment.text !== "string" || !segment.text.trim()) return null;
  return {
    v: 1,
    sessionId,
    speaker: "candidate",
    utteranceId: String(segment.id),
    text: segment.text.trim(),
    final: segment.final === true,
    language: segment.language || language,
    emittedAt: new Date().toISOString(),
    source: "livekit"
  };
}

export function mapLiveKitDataPacket(payload: unknown, sessionId: string): SubtitleInput | null {
  let parsed: unknown = payload;
  if (typeof payload === "string") {
    try { parsed = JSON.parse(payload); }
    catch { return null; }
  } else if (payload instanceof Uint8Array) {
    try { parsed = JSON.parse(new TextDecoder().decode(payload)); }
    catch { return null; }
  }
  const result = parseSubtitleInput(parsed);
  if (!result.ok) return null;
  if (result.value.sessionId !== sessionId && result.value.sessionId) {
    return { ...result.value, source: result.value.source || "livekit" };
  }
  return { ...result.value, sessionId, source: result.value.source || "livekit" };
}
