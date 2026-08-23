export type PipelineFieldValue = string | number | boolean;

export type PipelineEvent = {
  event: string;
  traceId?: string;
  fields: Record<string, PipelineFieldValue>;
};

const allowedFields = new Set([
  "audioFrames",
  "bytes",
  "code",
  "connected",
  "durationMs",
  "expectedRevision",
  "final",
  "httpStatus",
  "mode",
  "owner",
  "packetLossPct",
  "pid",
  "provider",
  "reason",
  "revision",
  "roomId",
  "sessionStatus",
  "sinkResolved",
  "source",
  "status",
  "textLength",
  "ttsState",
  "utteranceId"
]);
const eventPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const sensitiveFieldPattern = /(audio|key|password|secret|speech|text|token)/i;

export function normalizePipelineEvent(raw: unknown): PipelineEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.event !== "string" || input.event.length > 64 || !eventPattern.test(input.event)) return null;
  const traceId = normalizeString(input.traceId, 128);
  if (input.traceId != null && traceId == null) return null;
  if (input.fields == null || typeof input.fields !== "object" || Array.isArray(input.fields)) return null;
  const fields: Record<string, PipelineFieldValue> = {};
  for (const key of Object.keys(input.fields as Record<string, unknown>).sort()) {
    const value = (input.fields as Record<string, unknown>)[key];
    if (sensitiveFieldPattern.test(key) && key !== "textLength" && key !== "audioFrames") continue;
    if (!allowedFields.has(key)) {
      if (typeof value === "string" && value.length > 128) return null;
      continue;
    }
    if (typeof value === "string") {
      const normalized = normalizeString(value, 128);
      if (normalized == null) return null;
      fields[key] = normalized;
    } else if (typeof value === "boolean") {
      fields[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      fields[key] = value;
    }
  }
  return { event: input.event, ...(traceId ? { traceId } : {}), fields };
}

export function formatPipelineLog(event: PipelineEvent): string {
  const parts = [`[pipeline] event=${event.event}`];
  if (event.traceId) parts.push(`traceId=${logToken(event.traceId)}`);
  for (const [key, value] of Object.entries(event.fields)) parts.push(`${key}=${logToken(String(value))}`);
  return parts.join(" ");
}

function normalizeString(value: unknown, maxLength: number): string | null | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value.replace(/\s+/g, " ").trim();
}

function logToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "_");
}
