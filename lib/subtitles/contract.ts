export const SUBTITLE_PROTOCOL = "ai.interviewer.subtitle.v1";
export const SUBTITLE_PROTOCOL_VERSION = 1;
export const SUBTITLE_DATA_TOPIC = "subtitle.v1";

export const SUBTITLE_SPEAKERS = ["candidate"] as const;
export type SubtitleSpeaker = (typeof SUBTITLE_SPEAKERS)[number];

export const SUBTITLE_SOURCES = ["volcengine", "livekit", "direct-asr"] as const;
export type SubtitleSource = (typeof SUBTITLE_SOURCES)[number];

export type SubtitleInput = {
  v?: number;
  sessionId: string;
  speaker?: SubtitleSpeaker;
  utteranceId: string;
  text: string;
  final: boolean;
  language?: string;
  emittedAt?: string;
  source?: SubtitleSource | string;
  confidence?: number;
};

export type SubtitleLine = {
  sessionId: string;
  speaker: SubtitleSpeaker;
  utteranceId: string;
  text: string;
  final: boolean;
  language: string;
  emittedAt?: string;
  receivedAt: number;
  source?: string;
};

export type ParseSubtitleResult =
  | { ok: true; value: SubtitleInput }
  | { ok: false; error: string };

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const utteranceIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const languagePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})?$/;

export function parseSubtitleInput(raw: unknown): ParseSubtitleResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "subtitle payload must be an object" };
  }
  const value = raw as Record<string, unknown>;
  if (value.v != null && value.v !== SUBTITLE_PROTOCOL_VERSION) {
    return { ok: false, error: "unsupported subtitle protocol version" };
  }
  const sessionId = asTrimmedString(value.sessionId);
  if (!sessionId || !sessionIdPattern.test(sessionId)) {
    return { ok: false, error: "sessionId is required" };
  }
  const utteranceId = asTrimmedString(value.utteranceId);
  if (!utteranceId || !utteranceIdPattern.test(utteranceId)) {
    return { ok: false, error: "utteranceId is required" };
  }
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) {
    return { ok: false, error: "text is required" };
  }
  if (typeof value.final !== "boolean") {
    return { ok: false, error: "final must be a boolean" };
  }
  const speaker = value.speaker == null || value.speaker === "" ? "candidate" : value.speaker;
  if (speaker !== "candidate") {
    return { ok: false, error: "speaker must be candidate" };
  }
  const language = value.language == null || value.language === ""
    ? undefined
    : asTrimmedString(value.language);
  if (language && !languagePattern.test(language)) {
    return { ok: false, error: "language is invalid" };
  }
  const emittedAt = value.emittedAt == null || value.emittedAt === ""
    ? undefined
    : asTrimmedString(value.emittedAt);
  if (emittedAt && Number.isNaN(Date.parse(emittedAt))) {
    return { ok: false, error: "emittedAt is invalid" };
  }
  const source = value.source == null || value.source === ""
    ? undefined
    : asTrimmedString(value.source);
  const confidence = value.confidence;
  if (confidence != null && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
    return { ok: false, error: "confidence is invalid" };
  }
  return {
    ok: true,
    value: {
      v: SUBTITLE_PROTOCOL_VERSION,
      sessionId,
      speaker,
      utteranceId,
      text,
      final: value.final,
      language,
      emittedAt,
      source,
      confidence: typeof confidence === "number" ? confidence : undefined
    }
  };
}

export function encodeSubtitleV1(input: SubtitleInput): string {
  return JSON.stringify({
    v: SUBTITLE_PROTOCOL_VERSION,
    sessionId: input.sessionId,
    speaker: input.speaker || "candidate",
    utteranceId: input.utteranceId,
    text: input.text,
    final: input.final,
    language: input.language || "zh",
    emittedAt: input.emittedAt,
    source: input.source
  });
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
