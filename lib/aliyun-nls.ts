import { createHmac, randomUUID } from "node:crypto";

export const ALIYUN_NLS_TOKEN_URL = "https://nls-meta.cn-shanghai.aliyuncs.com/";
export const ALIYUN_NLS_TTS_PATH = "/stream/v1/tts";
export const ALIYUN_NLS_ASR_PATH = "/stream/v1/asr";
export const DEFAULT_ALIYUN_NLS_GATEWAY = "https://nls-gateway-cn-shanghai.aliyuncs.com";
export const DEFAULT_ALIYUN_VOICE = "xiaoyun";
export const DEFAULT_ALIYUN_SAMPLE_RATE = 16_000;
export const ALIYUN_ASR_SUCCESS_STATUS = 20_000_000;

export type AliyunNlsAuth = {
  appKey: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  token?: string;
  gateway?: string;
  voice?: string;
};

export type AliyunNlsToken = {
  id: string;
  expireTime: number;
};

const globalAliyun = globalThis as typeof globalThis & {
  aliyunNlsTokenCache?: { key: string; token: AliyunNlsToken };
};

export function percentEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

export function canonicalQuery(params: Record<string, string>) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
}

export function iso8601Utc(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildCreateTokenRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  timestamp: string;
  nonce: string;
}) {
  const params = {
    AccessKeyId: input.accessKeyId,
    Action: "CreateToken",
    Format: "JSON",
    RegionId: "cn-shanghai",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: input.nonce,
    SignatureVersion: "1.0",
    Timestamp: input.timestamp,
    Version: "2019-02-28"
  };
  const query = canonicalQuery(params);
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(query)}`;
  const signature = createHmac("sha1", `${input.accessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
  return {
    query,
    signature,
    stringToSign,
    url: `${ALIYUN_NLS_TOKEN_URL}?${query}&Signature=${percentEncode(signature)}`
  };
}

export function parseCreateTokenResponse(payload: unknown): AliyunNlsToken {
  if (!payload || typeof payload !== "object") throw new Error("ALIYUN_TOKEN_INVALID");
  const token = (payload as { Token?: { Id?: unknown; ExpireTime?: unknown } }).Token;
  const id = typeof token?.Id === "string" ? token.Id.trim() : "";
  const expireTime = Number(token?.ExpireTime);
  if (!id || !Number.isFinite(expireTime) || expireTime <= 0) {
    throw new Error("ALIYUN_TOKEN_INVALID");
  }
  return { id, expireTime };
}

function tokenCacheKey(auth: AliyunNlsAuth) {
  if (auth.token?.trim()) return `token:${auth.token.trim()}`;
  return `ak:${auth.accessKeyId || ""}:${auth.accessKeySecret || ""}`;
}

function cachedToken(auth: AliyunNlsAuth) {
  const cached = globalAliyun.aliyunNlsTokenCache;
  if (!cached || cached.key !== tokenCacheKey(auth)) return null;
  if (cached.token.expireTime * 1000 - 5 * 60_000 <= Date.now()) return null;
  return cached.token;
}

export async function createAliyunNlsToken(
  accessKeyId: string,
  accessKeySecret: string,
  timeoutMs = 8_000
): Promise<AliyunNlsToken> {
  const request = buildCreateTokenRequest({
    accessKeyId: accessKeyId.trim(),
    accessKeySecret: accessKeySecret.trim(),
    timestamp: iso8601Utc(),
    nonce: randomUUID()
  });
  const response = await fetch(request.url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => null) as {
    Code?: string;
    Message?: string;
    Token?: unknown;
  } | null;
  if (!response.ok) {
    const code = typeof payload?.Code === "string" ? payload.Code : "";
    const message = typeof payload?.Message === "string" ? payload.Message : "";
    throw new Error(message || code || `ALIYUN_TOKEN_${response.status}`);
  }
  return parseCreateTokenResponse(payload);
}

export async function resolveAliyunNlsToken(auth: AliyunNlsAuth) {
  const preset = auth.token?.trim();
  if (preset) return { id: preset, expireTime: Math.floor(Date.now() / 1000) + 24 * 3600 };
  const cached = cachedToken(auth);
  if (cached) return cached;
  const accessKeyId = auth.accessKeyId?.trim() || "";
  const accessKeySecret = auth.accessKeySecret?.trim() || "";
  if (!accessKeyId || !accessKeySecret) throw new Error("ALIYUN_AK_MISSING");
  const token = await createAliyunNlsToken(accessKeyId, accessKeySecret);
  globalAliyun.aliyunNlsTokenCache = { key: tokenCacheKey(auth), token };
  return token;
}

export function aliyunGateway(auth: AliyunNlsAuth) {
  return (auth.gateway || process.env.ALIYUN_NLS_GATEWAY || DEFAULT_ALIYUN_NLS_GATEWAY).replace(/\/$/, "");
}

export function parseWavSampleRate(bytes: Uint8Array) {
  if (bytes.length < 28) return DEFAULT_ALIYUN_SAMPLE_RATE;
  const header = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  if (header !== "RIFF" || wave !== "WAVE") return DEFAULT_ALIYUN_SAMPLE_RATE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  return sampleRate === 8_000 || sampleRate === 16_000 ? sampleRate : DEFAULT_ALIYUN_SAMPLE_RATE;
}

export function mapAliyunAsrFormat(mimeType: string) {
  const base = mimeType.split(";", 1)[0].toLowerCase();
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  if (base === "audio/ogg") return "opus";
  if (base === "audio/webm" || base === "video/webm") return "opus";
  if (base === "audio/mp4" || base === "video/mp4" || base === "audio/aac") return "aac";
  if (base === "audio/amr") return "amr";
  return "wav";
}

export function parseAliyunAsrText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { status?: unknown; result?: unknown; message?: unknown };
  const status = Number(record.status);
  if (Number.isFinite(status) && status !== ALIYUN_ASR_SUCCESS_STATUS) {
    const message = typeof record.message === "string" ? record.message : "ALIYUN_ASR_FAILED";
    throw new Error(message);
  }
  return typeof record.result === "string" ? record.result.trim() : "";
}

export function isAliyunTtsAudio(contentType: string, body: Uint8Array) {
  if (body.length >= 12) {
    const header = String.fromCharCode(...body.slice(0, 4));
    const wave = String.fromCharCode(...body.slice(8, 12));
    if (header === "RIFF" && wave === "WAVE") return true;
  }
  const type = contentType.split(";", 1)[0].toLowerCase();
  return type.startsWith("audio/");
}

export async function synthesizeAliyunSpeech(auth: AliyunNlsAuth, text: string, timeoutMs = 30_000) {
  const token = await resolveAliyunNlsToken(auth);
  const response = await fetch(`${aliyunGateway(auth)}${ALIYUN_NLS_TTS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-NLS-Token": token.id
    },
    body: JSON.stringify({
      appkey: auth.appKey.trim(),
      text,
      format: "wav",
      sample_rate: DEFAULT_ALIYUN_SAMPLE_RATE,
      voice: (auth.voice || DEFAULT_ALIYUN_VOICE).trim() || DEFAULT_ALIYUN_VOICE
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !isAliyunTtsAudio(contentType, bytes)) {
    const message = decodeAliyunError(bytes) || `ALIYUN_TTS_${response.status}`;
    throw new Error(message);
  }
  return bytes;
}

export async function recognizeAliyunSpeech(
  auth: AliyunNlsAuth,
  audio: Uint8Array,
  format: string,
  sampleRate = DEFAULT_ALIYUN_SAMPLE_RATE,
  timeoutMs = 30_000
) {
  const token = await resolveAliyunNlsToken(auth);
  const endpoint = new URL(`${aliyunGateway(auth)}${ALIYUN_NLS_ASR_PATH}`);
  endpoint.searchParams.set("appkey", auth.appKey.trim());
  endpoint.searchParams.set("format", format);
  endpoint.searchParams.set("sample_rate", String(sampleRate));
  endpoint.searchParams.set("enable_punctuation_prediction", "true");
  endpoint.searchParams.set("enable_inverse_text_normalization", "true");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-NLS-Token": token.id
    },
    body: audio,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(decodeAliyunErrorObject(payload) || `ALIYUN_ASR_${response.status}`);
  }
  return parseAliyunAsrText(payload);
}

function decodeAliyunError(bytes: Uint8Array) {
  try {
    return decodeAliyunErrorObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return "";
  }
}

function decodeAliyunErrorObject(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { message?: unknown; Message?: unknown };
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.Message === "string" && record.Message.trim()) return record.Message.trim();
  return "";
}
