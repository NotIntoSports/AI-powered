export const SESSION_COOKIE = "control_session";
export const BROWSER_PURPOSE = "browser";

export type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "operator";
  status: "active" | "disabled" | "deleted";
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  online?: boolean;
  lastSeenAt?: string;
  activeSessionCount?: number;
  voiceBound?: boolean;
  speakerId?: string;
  voiceBoundAt?: string;
};

export type SessionLine = {
  id: string;
  userId: string;
  username: string;
  purpose: "browser" | "desktop" | string;
  deviceId?: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  online: boolean;
};

export type PublicAISettings = {
  configured: boolean;
  available: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  questionTimeoutMs: number;
  reportTimeoutMs: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  localEndpoint: boolean;
  configVersion: number;
  updatedAt?: string;
  updatedByUsername?: string;
};

export type PublicRTCSettings = {
  configured: boolean;
  available: boolean;
  provider: string;
  language: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitSecretConfigured?: boolean;
  livekitConfigured?: boolean;
  livekitAvailable?: boolean;
  asrBaseUrl?: string;
  asrModel?: string;
  asrKeyConfigured?: boolean;
  pipelineMode?: "cascaded" | "e2e" | string;
  asrProviderId?: string;
  asrModelId?: string;
  llmProviderId?: string;
  llmModelId?: string;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoiceId?: string;
  e2eProviderId?: string;
  e2eModelId?: string;
  enabled: boolean;
  configVersion: number;
  updatedAt?: string;
  updatedByUsername?: string;
};

export type CatalogEntry = {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  baseUrl: string;
  capability: string;
  enabled: boolean;
  runtimeVerified: boolean;
  label: string;
  displayName?: string;
};

export type CatalogSyncResult = {
  providers: number;
  models: number;
  classified: number;
};

export type VoiceRoute = {
  id: string;
  name: string;
  mode: "cascaded" | "e2e" | string;
  asrProviderId: string;
  asrModelId: string;
  llmProviderId: string;
  llmModelId: string;
  ttsProviderId: string;
  ttsModelId: string;
  voiceId: string;
  e2eProviderId: string;
  e2eModelId: string;
  active: boolean;
  ready: boolean;
  status: string;
  configVersion: number;
  updatedAt: string;
};

export type OfficialCatalogSyncResult = {
  models: number;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  contentHash: string;
  lastSuccessAt?: string;
  warning?: string;
};

export type ModelVerificationResult = {
  modelId: string;
  capability: string;
  protocol: string;
  status: "success" | "failed" | "unsupported" | string;
  message: string;
};

export type ClientPipeline = {
  mode: "cascaded" | "e2e" | string;
  asr?: { providerId: string; providerName: string; modelId: string; baseUrl?: string; apiKey?: string; source?: string };
  llm?: { providerId: string; providerName: string; modelId: string; baseUrl?: string; apiKey?: string; source?: string };
  tts?: { providerId: string; providerName: string; modelId: string; baseUrl?: string; apiKey?: string; source?: string };
  e2e?: { providerId: string; providerName: string; modelId: string; baseUrl?: string; apiKey?: string; source?: string };
  voice?: string;
  e2eAvailable?: boolean;
  message?: string;
};

export type AITestResult = {
  reachable: boolean;
  modelFound: boolean;
  models?: string[];
  message: string;
};

export type RTCTestResult = {
  reachable: boolean;
  provider?: string;
  message: string;
};

export type PublicStorageSettings = {
  configured: boolean;
  available: boolean;
  provider: string;
  region: string;
  bucket: string;
  secretId: string;
  secretKeyConfigured: boolean;
  enabled: boolean;
  configVersion: number;
  updatedAt?: string;
  updatedByUsername?: string;
};

export type StorageTestResult = {
  reachable: boolean;
  message: string;
  buckets?: { name: string; region: string }[];
};

export type PublicSpeechSettings = {
  configured: boolean;
  available: boolean;
  ttsAvailable: boolean;
  asrAvailable: boolean;
  activeProvider?: "volcengine" | "aliyun" | string;
  appId: string;
  speakerId: string;
  ttsResourceId: string;
  asrResourceId: string;
  apiKeyConfigured: boolean;
  accessTokenConfigured: boolean;
  secretKeyConfigured: boolean;
  enabled: boolean;
  volcengineAvailable?: boolean;
  aliyunAvailable?: boolean;
  aliyunAppKey?: string;
  aliyunVoice?: string;
  aliyunGateway?: string;
  aliyunEnabled?: boolean;
  aliyunAccessKeyIdConfigured?: boolean;
  aliyunAccessKeySecretConfigured?: boolean;
  aliyunTokenConfigured?: boolean;
  ttsVolume?: number;
  ttsSpeechRate?: number;
  ttsPitchRate?: number;
  ttsSampleRate?: number;
  asrEnableItn?: boolean;
  asrEnablePunc?: boolean;
  asrModelName?: string;
  aliyunAsrCustomizationId?: string;
  aliyunAsrVocabularyId?: string;
  aliyunAsrEnableItn?: boolean;
  aliyunAsrEnablePunc?: boolean;
  aliyunAsrEnableDisfluency?: boolean;
  aliyunAsrEnableIntermediate?: boolean;
  aliyunAsrEnableSemanticBreak?: boolean;
  aliyunAsrMaxSentenceSilence?: number;
  aliyunAsrEnableVoiceDetection?: boolean;
  aliyunAsrMaxStartSilence?: number;
  aliyunAsrMaxEndSilence?: number;
  agentConsumer?: boolean;
  voiceAllocationStatus?: string;
  configVersion: number;
  updatedAt?: string;
  updatedByUsername?: string;
};

export type PublicPipelineSettings = {
  configured: boolean;
  mode: "cascaded" | "e2e" | string;
  e2eProvider: string;
  cascadedAsr: string;
  cascadedTts: string;
  enabled: boolean;
  configVersion: number;
  updatedAt?: string;
  updatedByUsername?: string;
};

export type SpeechTestResult = {
  reachable: boolean;
  provider?: string;
  message: string;
};

export type ResumeRecord = {
  id: string;
  uploadedByUserId: string;
  uploadedByUsername?: string;
  candidateName: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  indexStatus?: string;
  indexError?: string;
  indexedAt?: string;
};

export type PublicAIProvider = PublicAISettings & {
  id: string;
  name: string;
  isDefault: boolean;
};

export type DiscoveredModel = {
  id: string;
  modelId: string;
  baseUrl: string;
  enabled: boolean;
  ownedBy?: string;
  discoveredAt: string;
  updatedAt: string;
  capability?: string;
  officialSupported: boolean;
  keyDiscovered: boolean;
  verificationStatus: string;
  verificationMessage?: string;
  verifiedAt?: string;
  protocol?: string;
  officialSyncedAt?: string;
};

export type APIError = {
  code: string;
  message: string;
  requestId?: string;
};

export function buildLoginBody(username: string, password: string) {
  return {
    username,
    password,
    purpose: BROWSER_PURPOSE
  };
}

export function parseAPIError(payload: unknown, fallback = "请求失败"): APIError {
  if (!payload || typeof payload !== "object") {
    return { code: "INTERNAL_ERROR", message: fallback };
  }
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code ? record.code : "INTERNAL_ERROR";
  const message = typeof record.message === "string" && record.message ? record.message : fallback;
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  return { code, message, requestId };
}

export function publicUserFromUnknown(payload: unknown): PublicUser | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.username !== "string" ||
    (record.role !== "admin" && record.role !== "operator") ||
    (record.status !== "active" && record.status !== "disabled" && record.status !== "deleted")
  ) {
    return null;
  }
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    status: record.status,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    lastLoginAt: typeof record.lastLoginAt === "string" ? record.lastLoginAt : undefined,
    online: record.online === true,
    lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : undefined,
    activeSessionCount: typeof record.activeSessionCount === "number" ? record.activeSessionCount : 0,
    voiceBound: record.voiceBound === true,
    speakerId: typeof record.speakerId === "string" && record.speakerId ? record.speakerId : undefined,
    voiceBoundAt: typeof record.voiceBoundAt === "string" ? record.voiceBoundAt : undefined
  };
}

export function displayError(error: APIError): string {
  switch (error.code) {
    case "INVALID_CREDENTIALS":
    case "LOGIN_FAILED":
      return "登录失败";
    case "RATE_LIMITED":
      return "尝试次数过多，请稍后再试";
    case "LAST_ADMIN_REQUIRED":
      return "不能停用最后一位启用中的管理员";
    case "CANNOT_DISABLE_SELF":
      return "不能禁用当前登录的管理员";
    case "RESUME_NOT_FOUND":
      return "资料不存在或已删除";
    case "SETTINGS_STORE_UNAVAILABLE":
      return "设置库暂时不可用，请稍后重试。若持续出现，请查看 control-api 日志中的数据库错误。";
    case "INVALID_INPUT":
      return "提交的内容无效。若在启用模型，请确认该模型已在官方名单或已发现列表中。";
    case "MODEL_NOT_VERIFIED":
      return "该模型尚未通过本人验证，无法用于当前线路。Realtime / ASR / TTS 专用协议只需先启用，不必用 Chat Completions 实测。";
    default:
      return error.message;
  }
}

export async function readJSON(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function requestJSON(path: string, init: RequestInit = {}): Promise<{
  response: Response;
  body: unknown;
}> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers
  });
  const body = await readJSON(response);
  return { response, body };
}
