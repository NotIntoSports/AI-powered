export const AGENT_RESPONSE_PROTOCOL_VERSION = 1;
export const AGENT_RESPONSE_DATA_TOPIC = "agent.response.v1";

export type AgentResponseInput = {
  v?: number;
  sessionId: string;
  utteranceId: string;
  candidateText: string;
  replyText: string;
  final: boolean;
  language?: string;
  emittedAt?: string;
  source?: string;
};

export type AgentResponseLine = {
  sessionId: string;
  utteranceId: string;
  candidateText: string;
  replyText: string;
  final: boolean;
  language: string;
  emittedAt?: string;
  receivedAt: number;
  source?: string;
};

export type ParseAgentResponseResult =
  | { ok: true; value: AgentResponseInput }
  | { ok: false; error: string };

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const utteranceIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAgentResponseInput(raw: unknown): ParseAgentResponseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "agent response payload must be an object" };
  }
  const value = raw as Record<string, unknown>;
  if (value.v != null && value.v !== AGENT_RESPONSE_PROTOCOL_VERSION) {
    return { ok: false, error: "unsupported agent response protocol version" };
  }
  const sessionId = asTrimmedString(value.sessionId);
  if (!sessionId || !sessionIdPattern.test(sessionId)) {
    return { ok: false, error: "sessionId is required" };
  }
  const utteranceId = asTrimmedString(value.utteranceId);
  if (!utteranceId || !utteranceIdPattern.test(utteranceId)) {
    return { ok: false, error: "utteranceId is required" };
  }
  const candidateText = asTrimmedString(value.candidateText);
  const replyText = asTrimmedString(value.replyText);
  if (!candidateText || !replyText) {
    return { ok: false, error: "candidateText and replyText are required" };
  }
  if (typeof value.final !== "boolean") {
    return { ok: false, error: "final must be a boolean" };
  }
  const language = value.language == null || value.language === ""
    ? undefined
    : asTrimmedString(value.language);
  const emittedAt = value.emittedAt == null || value.emittedAt === ""
    ? undefined
    : asTrimmedString(value.emittedAt);
  if (emittedAt && Number.isNaN(Date.parse(emittedAt))) {
    return { ok: false, error: "emittedAt is invalid" };
  }
  const source = value.source == null || value.source === ""
    ? undefined
    : asTrimmedString(value.source);
  return {
    ok: true,
    value: {
      v: AGENT_RESPONSE_PROTOCOL_VERSION,
      sessionId,
      utteranceId,
      candidateText,
      replyText,
      final: value.final,
      language,
      emittedAt,
      source
    }
  };
}

export function mapAgentResponseDataPacket(payload: unknown, sessionId: string): AgentResponseInput | null {
  let parsed: unknown = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
  } else if (payload instanceof Uint8Array) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
  }
  const result = parseAgentResponseInput(parsed);
  if (!result.ok) return null;
  return { ...result.value, sessionId: result.value.sessionId || sessionId };
}
