import { getModelRuntimeConfig } from "./runtime-config";
import {
  areEquivalentBaseUrls,
  isSecureEndpoint,
  selectScopedApiKey
} from "./endpoint-security";

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export type TranscriptionProvider = "openai" | "whisper-cpp";

type TranscriptionResult = {
  text?: string;
  error?: { message?: string } | string;
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

export function getTranscriptionProvider(): TranscriptionProvider {
  return process.env.TRANSCRIPTION_PROVIDER === "whisper-cpp" ? "whisper-cpp" : "openai";
}

export async function isTranscriptionConfigured() {
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

export async function isTranscriptionReady() {
  if (!await isTranscriptionConfigured()) return false;
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

export async function transcribeAudio(file: File) {
  await validateAudioFile(file);
  const provider = getTranscriptionProvider();
  return provider === "whisper-cpp"
    ? transcribeWithWhisperCpp(file)
    : transcribeWithOpenAI(file);
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
  const runtime = await getModelRuntimeConfig();
  const baseUrl = (
    process.env.TRANSCRIPTION_BASE_URL ||
    runtime.baseUrl
  ).replace(/\/$/, "");
  if (!isSecureTranscriptionEndpoint(baseUrl)) {
    throw new Error("INSECURE_TRANSCRIPTION_ENDPOINT");
  }
  const apiKey = selectTranscriptionApiKey({
    explicitKey: process.env.TRANSCRIPTION_API_KEY,
    transcriptionBaseUrl: baseUrl,
    modelBaseUrl: runtime.baseUrl,
    modelApiKey: runtime.apiKey
  });
  if (!apiKey) throw new Error("MISSING_TRANSCRIPTION_KEY");

  const form = new FormData();
  form.append("file", file, file.name || "meeting-audio.webm");
  form.append("model", process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", process.env.TRANSCRIPTION_LANGUAGE || "zh");
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
