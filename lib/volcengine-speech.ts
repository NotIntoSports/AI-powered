import { wrapPcmAsWav } from "./pcm-wav";
import { DEFAULT_CUSTOM_SPEAKER_ID } from "./voice-clone-script";

export const VOLCENGINE_CLONE_URL = "https://openspeech.bytedance.com/api/v3/tts/voice_clone";
export const VOLCENGINE_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
export const VOLCENGINE_ASR_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
export const DEFAULT_TTS_RESOURCE_ID = "seed-icl-2.0";
export const DEFAULT_ASR_RESOURCE_ID = "volc.bigasr.auc_turbo";

export type VolcengineSpeechAuth = {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
};

export function volcengineSpeechHeaders(
  auth: VolcengineSpeechAuth,
  resourceId?: string,
  requestId?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Request-Id": requestId || crypto.randomUUID()
  };
  const apiKey = auth.apiKey?.trim();
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  } else {
    headers["X-Api-App-Key"] = (auth.appId || "").trim();
    headers["X-Api-Access-Key"] = (auth.accessToken || "").trim();
  }
  if (resourceId) headers["X-Api-Resource-Id"] = resourceId;
  return headers;
}

export function isPrepaidSpeakerId(speakerId: string) {
  return /^S_/i.test(speakerId.trim());
}

export function resolveCloneSpeaker(speakerId?: string) {
  const trimmed = (speakerId || "").trim();
  if (trimmed && isPrepaidSpeakerId(trimmed)) {
    return { speaker_id: trimmed };
  }
  return {
    speaker_id: "custom_speaker_id",
    custom_speaker_id: trimmed || DEFAULT_CUSTOM_SPEAKER_ID
  };
}

export function buildVoiceCloneBody(input: {
  audioBase64: string;
  format?: string;
  text: string;
  speakerId?: string;
}) {
  return {
    ...resolveCloneSpeaker(input.speakerId),
    audio: {
      data: input.audioBase64,
      format: input.format || "wav"
    },
    text: input.text,
    language: 0
  };
}

export function isVoiceCloneBusinessError(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const code = Number((payload as Record<string, unknown>).code);
  return Number.isFinite(code) && code !== 0 && code !== 20_000_000;
}

function readSpeakerCandidate(record: Record<string, unknown>) {
  for (const key of ["speaker_id", "custom_speaker_id", "speakerId", "customSpeakerId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && value.trim() !== "custom_speaker_id") {
      return value.trim();
    }
  }
  return "";
}

export function parseVoiceCloneSpeakerId(payload: unknown, fallbackSpeakerId = "") {
  if (!payload || typeof payload !== "object") return "";
  if (isVoiceCloneBusinessError(payload)) return "";
  const record = payload as Record<string, unknown>;
  const direct = readSpeakerCandidate(record);
  if (direct) return direct;
  for (const nestedKey of ["data", "result"]) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object") {
      const found = readSpeakerCandidate(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return fallbackSpeakerId && isPrepaidSpeakerId(fallbackSpeakerId) ? fallbackSpeakerId.trim() : "";
}

export function buildUnidirectionalTtsBody(text: string, speaker: string) {
  return {
    user: { uid: "interviewer" },
    req_params: {
      text,
      speaker,
      audio_params: {
        format: "wav",
        sample_rate: 24000
      }
    }
  };
}

export function concatTtsAudioChunks(raw: string) {
  const pieces = splitNdjson(raw);
  const audio: Buffer[] = [];
  for (const piece of pieces) {
    const parsed = parseJsonObject(piece);
    if (!parsed) continue;
    const code = Number(parsed.code);
    if (Number.isFinite(code) && code !== 0 && code !== 20000000) {
      const message = typeof parsed.message === "string" ? parsed.message : "TTS_FAILED";
      throw new Error(message);
    }
    const data = extractBase64Audio(parsed);
    if (data) audio.push(Buffer.from(data, "base64"));
  }
  if (!audio.length) throw new Error("TTS_EMPTY");
  return wrapPcmAsWav(new Uint8Array(Buffer.concat(audio)));
}

export function mapTranscriptionFormat(mimeType: string) {
  const base = mimeType.split(";", 1)[0].toLowerCase();
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  if (base === "audio/ogg" || base === "audio/webm" || base === "video/webm") return "ogg";
  if (base === "audio/mp4" || base === "video/mp4") return "mp3";
  return "wav";
}

export function buildFlashAsrBody(audioBase64: string, format: string) {
  return {
    user: { uid: "interviewer" },
    audio: {
      data: audioBase64,
      format
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: false
    }
  };
}

export function parseFlashAsrText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const text = (result as Record<string, unknown>).text;
    if (typeof text === "string") return text.trim();
  }
  if (typeof record.text === "string") return record.text.trim();
  return "";
}

function extractBase64Audio(record: Record<string, unknown>) {
  if (typeof record.data === "string" && record.data) return record.data;
  if (typeof record.audio === "string" && record.audio) return record.audio;
  if (record.data && typeof record.data === "object") {
    const nested = (record.data as Record<string, unknown>).data;
    if (typeof nested === "string" && nested) return nested;
  }
  return "";
}

function splitNdjson(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/).map((line) => line.replace(/^data:\s*/, "").trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  if (trimmed.startsWith("{") && trimmed.includes("}{")) {
    return trimmed.replace(/}\s*{/g, "}\n{").split("\n");
  }
  return [trimmed];
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function volcengineJsonRequest(input: {
  url: string;
  auth: VolcengineSpeechAuth;
  body: unknown;
  resourceId?: string;
  timeoutMs?: number;
}) {
  const response = await fetch(input.url, {
    method: "POST",
    headers: volcengineSpeechHeaders(input.auth, input.resourceId),
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000)
  });
  const text = await response.text();
  return { response, text };
}
