import { fetchDesktopControlJson, getModelRuntimeConfig } from "./runtime-config";
import {
  areEquivalentBaseUrls,
  isSecureEndpoint,
  selectScopedApiKey
} from "./endpoint-security";
import { getSpeechRuntimeConfig, toAliyunNlsAuth } from "./speech-runtime";
import {
  mapAliyunAsrFormat,
  parseWavSampleRate,
  recognizeAliyunSpeech
} from "./aliyun-nls";
import {
  buildFlashAsrBody,
  mapTranscriptionFormat,
  parseFlashAsrText,
  VOLCENGINE_ASR_URL,
  volcengineJsonRequest
} from "./volcengine-speech";

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export type TranscriptionProvider = "openai" | "whisper-cpp";
export type TranscriptionSource = "aliyun" | "volcengine" | "management" | "environment" | "whisper-cpp" | "none";

type TranscriptionResult = {
  text?: string;
  error?: { message?: string } | string;
};

type ManagementASR = {
  available: boolean;
  baseUrl: string;
  model: string;
  language: string;
  apiKey: string;
};

const supportedTypes = new Set([
  "audio/webm",
  "video/webm",
  "audio/ogg",
  "audio/mp4",
  "video/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav"
]);

const globalTranscription = globalThis as typeof globalThis & {
  managementAsrCache?: { at: number; config: ManagementASR | null };
};

export function isSecureTranscriptionEndpoint(value: string) {
  return isSecureEndpoint(value);
}

export function canReuseModelApiKey(
  transcriptionBaseUrl: string,
  modelBaseUrl: string
) {
  return areEquivalentBaseUrls(transcriptionBaseUrl, modelBaseUrl);
}

export function selectTranscriptionApiKey(input: {
  explicitKey?: string;
  transcriptionBaseUrl: string;
  modelBaseUrl: string;
  modelApiKey: string;
}) {
  return selectScopedApiKey({
    explicitKey: input.explicitKey,
    targetBaseUrl: input.transcriptionBaseUrl,
    fallbackBaseUrl: input.modelBaseUrl,
    fallbackApiKey: input.modelApiKey
  });
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function hasKnownSignature(bytes: Uint8Array) {
  return (
    (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) ||
    ascii(bytes, 0, 4) === "OggS" ||
    (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") ||
    ascii(bytes, 4, 8) === "ftyp" ||
    ascii(bytes, 0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}

async function getManagementASRConfig(): Promise<ManagementASR | null> {
  const cached = globalTranscription.managementAsrCache;
  if (cached && Date.now() - cached.at < 5_000) {
    return cached.config;
  }
  const data = await fetchDesktopControlJson<{
    available?: boolean;
    baseUrl?: string;
    model?: string;
    language?: string;
    apiKey?: string;
  }>("/api/v1/client/settings/asr");
  if (!data) {
    globalTranscription.managementAsrCache = { at: Date.now(), config: null };
    return null;
  }
  const config: ManagementASR = {
    available: Boolean(data.available),
    baseUrl: String(data.baseUrl || "").replace(/\/$/, ""),
    model: String(data.model || "whisper-1"),
    language: String(data.language || "zh"),
    apiKey: typeof data.apiKey === "string" ? data.apiKey : ""
  };
  if (!config.available || !isSecureTranscriptionEndpoint(config.baseUrl)) {
    globalTranscription.managementAsrCache = { at: Date.now(), config: null };
    return null;
  }
  globalTranscription.managementAsrCache = { at: Date.now(), config };
  return config;
}

export function getTranscriptionProvider(): TranscriptionProvider {
  return process.env.TRANSCRIPTION_PROVIDER === "whisper-cpp" ? "whisper-cpp" : "openai";
}

export async function getTranscriptionSource(): Promise<TranscriptionSource> {
  const speech = await getSpeechRuntimeConfig();
  if (speech.provider === "aliyun" && speech.asrAvailable) return "aliyun";
  if (speech.provider === "volcengine" && speech.asrAvailable) return "volcengine";
  if (await getManagementASRConfig()) return "management";
  if (getTranscriptionProvider() === "whisper-cpp") return "whisper-cpp";
  if (await isLocalTranscriptionConfigured()) return "environment";
  return "none";
}

async function isLocalTranscriptionConfigured() {
  const provider = getTranscriptionProvider();
  if (provider === "whisper-cpp") {
    return isSecureTranscriptionEndpoint(
      process.env.WHISPER_CPP_URL || "http://127.0.0.1:8080/inference"
    );
  }
  const runtime = await getModelRuntimeConfig();
  const baseUrl = (process.env.TRANSCRIPTION_BASE_URL || runtime.baseUrl).replace(/\/$/, "");
  if (!isSecureTranscriptionEndpoint(baseUrl)) return false;
  return Boolean(selectTranscriptionApiKey({
    explicitKey: process.env.TRANSCRIPTION_API_KEY,
    transcriptionBaseUrl: baseUrl,
    modelBaseUrl: runtime.baseUrl,
    modelApiKey: runtime.apiKey
  }));
}

export async function isTranscriptionConfigured() {
  if ((await getSpeechRuntimeConfig()).asrAvailable) return true;
  if (await getManagementASRConfig()) return true;
  return isLocalTranscriptionConfigured();
}

export async function isTranscriptionReady() {
  if ((await getSpeechRuntimeConfig()).asrAvailable) return true;
  const management = await getManagementASRConfig();
  if (management) return true;
  if (!await isLocalTranscriptionConfigured()) return false;
  if (getTranscriptionProvider() !== "whisper-cpp") return true;
  try {
    const endpoint = new URL(process.env.WHISPER_CPP_URL || "http://127.0.0.1:8080/inference");
    endpoint.pathname = "/";
    endpoint.search = "";
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(1_200),
      cache: "no-store"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function validateAudioFile(file: File) {
  if (file.size === 0 || file.size > MAX_AUDIO_BYTES) throw new Error("INVALID_AUDIO_SIZE");
  const baseMimeType = file.type.split(";", 1)[0].toLowerCase();
  if (!supportedTypes.has(baseMimeType)) throw new Error("UNSUPPORTED_AUDIO");
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!hasKnownSignature(bytes)) throw new Error("UNSUPPORTED_AUDIO");
}

/** Workspace display capture uploads use meeting-* filenames. */
export function isMeetingTranscriptionFile(file: File) {
  return (file.name || "").startsWith("meeting-");
}

/**
 * LiveKit bridge publishes candidate ASR via livekit-agent on subtitle.v1.
 * Skip direct cloud ASR for meeting uploads so we do not double-transcribe.
 */
export function shouldUseDirectCloudAsr(file: File) {
  return !isMeetingTranscriptionFile(file);
}

export async function transcribeAudio(file: File) {
  await validateAudioFile(file);
  if (shouldUseDirectCloudAsr(file)) {
    const speech = await getSpeechRuntimeConfig();
    if (speech.provider === "aliyun" && speech.asrAvailable) {
      try {
        const text = await transcribeWithAliyun(file);
        if (text) return text;
      } catch {
        // Fall back to OpenAI-compatible or whisper.cpp.
      }
    }
    if (speech.provider === "volcengine" && speech.asrAvailable) {
      try {
        const text = await transcribeWithVolcengine(file);
        if (text) return text;
      } catch {
        // Fall back to OpenAI-compatible or whisper.cpp.
      }
    }
  } else {
    console.log(
      "[transcribe] meeting path: skipping direct cloud ASR (LiveKit agent subtitles); whisper/env fallback only"
    );
  }
  if (await getManagementASRConfig() || getTranscriptionProvider() !== "whisper-cpp") {
    return transcribeWithOpenAI(file);
  }
  return transcribeWithWhisperCpp(file);
}

async function transcribeWithAliyun(file: File) {
  const speech = await getSpeechRuntimeConfig();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return recognizeAliyunSpeech(
    toAliyunNlsAuth(speech),
    bytes,
    mapAliyunAsrFormat(file.type),
    parseWavSampleRate(bytes)
  );
}

async function transcribeWithVolcengine(file: File) {
  const speech = await getSpeechRuntimeConfig();
  const bytes = Buffer.from(await file.arrayBuffer());
  const { response, text } = await volcengineJsonRequest({
    url: VOLCENGINE_ASR_URL,
    auth: speech,
    body: buildFlashAsrBody(bytes.toString("base64"), mapTranscriptionFormat(file.type)),
    resourceId: speech.asrResourceId,
    timeoutMs: 30_000
  });
  const payload = JSON.parse(text) as unknown;
  if (!response.ok) throw new Error(`TRANSCRIPTION_UPSTREAM_${response.status}`);
  return parseFlashAsrText(payload);
}

async function transcribeWithWhisperCpp(file: File) {
  const endpoint = process.env.WHISPER_CPP_URL || "http://127.0.0.1:8080/inference";
  if (!isSecureTranscriptionEndpoint(endpoint)) {
    throw new Error("INSECURE_TRANSCRIPTION_ENDPOINT");
  }
  const form = new FormData();
  form.append("file", file, file.name || "meeting-audio.webm");
  form.append("language", process.env.TRANSCRIPTION_LANGUAGE || "zh");
  form.append("response_format", "json");
  form.append("temperature", "0.0");

  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  return parseTranscriptionResponse(response);
}

async function transcribeWithOpenAI(file: File) {
  const management = await getManagementASRConfig();
  const runtime = await getModelRuntimeConfig();
  const baseUrl = (management?.baseUrl || process.env.TRANSCRIPTION_BASE_URL || runtime.baseUrl).replace(/\/$/, "");
  if (!isSecureTranscriptionEndpoint(baseUrl)) {
    throw new Error("INSECURE_TRANSCRIPTION_ENDPOINT");
  }
  const apiKey = management?.apiKey || selectTranscriptionApiKey({
    explicitKey: process.env.TRANSCRIPTION_API_KEY,
    transcriptionBaseUrl: baseUrl,
    modelBaseUrl: runtime.baseUrl,
    modelApiKey: runtime.apiKey
  });
  if (!apiKey) throw new Error("MISSING_TRANSCRIPTION_KEY");

  const form = new FormData();
  form.append("file", file, file.name || "meeting-audio.webm");
  form.append("model", management?.model || process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", management?.language || process.env.TRANSCRIPTION_LANGUAGE || "zh");
  form.append("response_format", "json");

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  return parseTranscriptionResponse(response);
}

async function parseTranscriptionResponse(response: Response) {
  const body = await response.json().catch(() => null) as TranscriptionResult | null;
  if (!response.ok) {
    const upstreamMessage = typeof body?.error === "string"
      ? body.error
      : body?.error?.message;
    throw new Error(upstreamMessage || `TRANSCRIPTION_UPSTREAM_${response.status}`);
  }
  const text = body?.text?.trim();
  if (!text) return "";
  return text;
}
