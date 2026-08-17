import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_ALIYUN_VOICE, type AliyunNlsAuth } from "./aliyun-nls";
import {
  fetchDesktopControlJson,
  localSettingsDirectory,
  unprotectLocalSecret
} from "./runtime-config";
import { DEFAULT_ASR_RESOURCE_ID, DEFAULT_TTS_RESOURCE_ID } from "./volcengine-speech";

const speechSettingsSchema = z.object({
  provider: z.enum(["aliyun", "volcengine"]).default("volcengine"),
  appId: z.string().max(200).default(""),
  speakerId: z.string().max(256).default(""),
  ttsResourceId: z.string().max(128).default(DEFAULT_TTS_RESOURCE_ID),
  asrResourceId: z.string().max(128).default(DEFAULT_ASR_RESOURCE_ID),
  encryptedApiKey: z.string().min(1).nullable().optional(),
  encryptedAccessToken: z.string().min(1).nullable().optional(),
  encryptedSecretKey: z.string().min(1).nullable().optional(),
  disabled: z.boolean().default(false)
});

type StoredSpeech = z.infer<typeof speechSettingsSchema>;
export type SpeechProvider = "aliyun" | "volcengine" | "none";

export type SpeechRuntimeConfig = {
  provider: SpeechProvider;
  apiKey: string;
  appId: string;
  accessToken: string;
  accessKeyId: string;
  accessKeySecret: string;
  speakerId: string;
  ttsResourceId: string;
  asrResourceId: string;
  source: "management" | "settings" | "environment" | "none";
  available: boolean;
  ttsAvailable: boolean;
  asrAvailable: boolean;
};

const speechPath = path.join(localSettingsDirectory(), "speech.json");

const globalSpeech = globalThis as typeof globalThis & {
  speechSettingsPromise?: Promise<StoredSpeech | null>;
  decryptedSpeechApiKey?: string;
  decryptedSpeechAccessToken?: string;
  decryptedSpeechSecretKey?: string;
};

function emptySpeech(source: SpeechRuntimeConfig["source"] = "none"): SpeechRuntimeConfig {
  return {
    provider: "none",
    apiKey: "",
    appId: "",
    accessToken: "",
    accessKeyId: "",
    accessKeySecret: "",
    speakerId: "",
    ttsResourceId: DEFAULT_TTS_RESOURCE_ID,
    asrResourceId: DEFAULT_ASR_RESOURCE_ID,
    source,
    available: false,
    ttsAvailable: false,
    asrAvailable: false
  };
}

function withAvailability(config: Omit<SpeechRuntimeConfig, "available" | "ttsAvailable" | "asrAvailable">): SpeechRuntimeConfig {
  if (config.provider === "aliyun") {
    const available = Boolean(
      config.appId && (config.accessToken || (config.accessKeyId && config.accessKeySecret))
    );
    return {
      ...config,
      speakerId: config.speakerId || DEFAULT_ALIYUN_VOICE,
      available,
      asrAvailable: available,
      ttsAvailable: available
    };
  }
  const available = Boolean(config.apiKey || (config.appId && config.accessToken));
  return {
    ...config,
    available,
    asrAvailable: available,
    ttsAvailable: available && Boolean(config.speakerId)
  };
}

async function loadStoredSpeech() {
  try {
    return speechSettingsSchema.parse(JSON.parse(await readFile(speechPath, "utf8")));
  } catch {
    return null;
  }
}

async function getStoredSpeech() {
  globalSpeech.speechSettingsPromise ??= loadStoredSpeech();
  return globalSpeech.speechSettingsPromise;
}

async function writeStoredSpeech(settings: StoredSpeech) {
  await mkdir(localSettingsDirectory(), { recursive: true });
  const temporaryPath = `${speechPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, speechPath);
  globalSpeech.speechSettingsPromise = Promise.resolve(settings);
}

function fromManagement(data: {
  available?: boolean;
  activeProvider?: string;
  appId?: string;
  speakerId?: string;
  ttsResourceId?: string;
  asrResourceId?: string;
  apiKey?: string;
  accessToken?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  aliyunToken?: string;
  aliyunAppKey?: string;
  aliyunVoice?: string;
}): SpeechRuntimeConfig | null {
  const provider = data.activeProvider === "aliyun" ? "aliyun" : "volcengine";
  if (provider === "aliyun") {
    const config = withAvailability({
      provider: "aliyun",
      apiKey: "",
      appId: String(data.aliyunAppKey || data.appId || ""),
      accessToken: typeof data.aliyunToken === "string" ? data.aliyunToken : "",
      accessKeyId: typeof data.accessKeyId === "string" ? data.accessKeyId : "",
      accessKeySecret: typeof data.accessKeySecret === "string" ? data.accessKeySecret : "",
      speakerId: String(data.aliyunVoice || data.speakerId || DEFAULT_ALIYUN_VOICE),
      ttsResourceId: String(data.ttsResourceId || DEFAULT_TTS_RESOURCE_ID),
      asrResourceId: String(data.asrResourceId || DEFAULT_ASR_RESOURCE_ID),
      source: "management"
    });
    if (!data.available && !config.available) return null;
    return config;
  }
  const config = withAvailability({
    provider: "volcengine",
    apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
    appId: String(data.appId || ""),
    accessToken: typeof data.accessToken === "string" ? data.accessToken : "",
    accessKeyId: "",
    accessKeySecret: "",
    speakerId: String(data.speakerId || ""),
    ttsResourceId: String(data.ttsResourceId || DEFAULT_TTS_RESOURCE_ID),
    asrResourceId: String(data.asrResourceId || DEFAULT_ASR_RESOURCE_ID),
    source: "management"
  });
  if (!data.available && !config.available) return null;
  return config;
}

async function getManagementSpeechConfig(): Promise<SpeechRuntimeConfig | null> {
  const data = await fetchDesktopControlJson<{
    available?: boolean;
    activeProvider?: string;
    appId?: string;
    speakerId?: string;
    ttsResourceId?: string;
    asrResourceId?: string;
    apiKey?: string;
    accessToken?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    aliyunToken?: string;
    aliyunAppKey?: string;
    aliyunVoice?: string;
  }>("/api/v1/client/settings/speech");
  if (!data) return null;
  return fromManagement(data);
}

function fromStoredSpeech(stored: StoredSpeech): SpeechRuntimeConfig {
  let apiKey = "";
  let accessToken = "";
  let secretKey = "";
  if (stored.encryptedApiKey) {
    globalSpeech.decryptedSpeechApiKey ??= unprotectLocalSecret(stored.encryptedApiKey);
    apiKey = globalSpeech.decryptedSpeechApiKey;
  }
  if (stored.encryptedAccessToken) {
    globalSpeech.decryptedSpeechAccessToken ??= unprotectLocalSecret(stored.encryptedAccessToken);
    accessToken = globalSpeech.decryptedSpeechAccessToken;
  }
  if (stored.encryptedSecretKey) {
    globalSpeech.decryptedSpeechSecretKey ??= unprotectLocalSecret(stored.encryptedSecretKey);
    secretKey = globalSpeech.decryptedSpeechSecretKey;
  }
  const provider = stored.provider === "aliyun" ? "aliyun" : "volcengine";
  return withAvailability({
    provider,
    apiKey,
    appId: stored.appId,
    accessToken,
    accessKeyId: provider === "aliyun" ? apiKey : "",
    accessKeySecret: provider === "aliyun" ? secretKey : "",
    speakerId: stored.speakerId,
    ttsResourceId: stored.ttsResourceId || DEFAULT_TTS_RESOURCE_ID,
    asrResourceId: stored.asrResourceId || DEFAULT_ASR_RESOURCE_ID,
    source: "settings"
  });
}

function fromAliyunEnv(): SpeechRuntimeConfig {
  return withAvailability({
    provider: "aliyun",
    apiKey: "",
    appId: process.env.ALIYUN_NLS_APPKEY || "",
    accessToken: process.env.ALIYUN_NLS_TOKEN || "",
    accessKeyId: process.env.ALIYUN_NLS_ACCESS_KEY_ID || process.env.ALIYUN_AK_ID || "",
    accessKeySecret: process.env.ALIYUN_NLS_ACCESS_KEY_SECRET || process.env.ALIYUN_AK_SECRET || "",
    speakerId: process.env.ALIYUN_NLS_VOICE || DEFAULT_ALIYUN_VOICE,
    ttsResourceId: DEFAULT_TTS_RESOURCE_ID,
    asrResourceId: DEFAULT_ASR_RESOURCE_ID,
    source: "environment"
  });
}

function fromVolcengineEnv(): SpeechRuntimeConfig {
  return withAvailability({
    provider: "volcengine",
    apiKey: process.env.VOLCENGINE_SPEECH_API_KEY || "",
    appId: process.env.VOLCENGINE_SPEECH_APP_ID || "",
    accessToken: process.env.VOLCENGINE_SPEECH_ACCESS_TOKEN || "",
    accessKeyId: "",
    accessKeySecret: "",
    speakerId: process.env.VOLCENGINE_SPEECH_SPEAKER_ID || "",
    ttsResourceId: DEFAULT_TTS_RESOURCE_ID,
    asrResourceId: DEFAULT_ASR_RESOURCE_ID,
    source: "environment"
  });
}

export async function getSpeechRuntimeConfig(): Promise<SpeechRuntimeConfig> {
  const preferred = (process.env.SPEECH_PROVIDER || "auto").trim().toLowerCase();
  const management = await getManagementSpeechConfig();
  const stored = await getStoredSpeech();
  const aliyunEnv = fromAliyunEnv();
  const volcengineEnv = fromVolcengineEnv();
  const local = stored && !stored.disabled ? fromStoredSpeech(stored) : null;

  // Management is the source of truth when the desktop session can read it.
  if (management?.available && preferred === "auto") {
    return withAvailability({
      ...management,
      speakerId: management.speakerId || stored?.speakerId || management.speakerId
    });
  }
  if (preferred === "aliyun") {
    if (management?.provider === "aliyun" && management.available) return management;
    if (local?.provider === "aliyun" && local.available) return local;
    if (aliyunEnv.available) return aliyunEnv;
    if (aliyunEnv.appId) return aliyunEnv;
  }
  if (preferred === "volcengine") {
    if (management?.provider === "volcengine" && management.available) {
      return withAvailability({
        ...management,
        speakerId: management.speakerId || stored?.speakerId || ""
      });
    }
    if (local?.provider === "volcengine" && local.available) return local;
    if (volcengineEnv.available) return volcengineEnv;
  }
  if (preferred !== "volcengine") {
    if (aliyunEnv.available) return aliyunEnv;
    if (local?.provider === "aliyun" && local.available) return local;
  }
  if (preferred !== "aliyun" && management?.available) {
    return withAvailability({
      ...management,
      speakerId: management.speakerId || stored?.speakerId || ""
    });
  }
  if (preferred !== "aliyun" && local?.available) return local;
  if (preferred !== "aliyun" && volcengineEnv.available) return volcengineEnv;
  if (aliyunEnv.appId) return aliyunEnv;
  if (management) return management;
  return emptySpeech(stored ? "settings" : "none");
}

export function toAliyunNlsAuth(config: SpeechRuntimeConfig): AliyunNlsAuth {
  return {
    appKey: config.appId,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    token: config.accessToken,
    voice: config.speakerId || DEFAULT_ALIYUN_VOICE
  };
}

export async function saveSpeechSpeakerId(speakerId: string) {
  const trimmed = speakerId.trim();
  const current = (await getStoredSpeech()) ?? speechSettingsSchema.parse({});
  await writeStoredSpeech({ ...current, speakerId: trimmed, disabled: false });
  const synced = await fetchDesktopControlJson<{ speakerId?: string }>("/api/v1/client/settings/speech", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speakerId: trimmed }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!synced) {
    throw new SpeechAccountBindError();
  }
  return getSpeechRuntimeConfig();
}

export class SpeechAccountBindError extends Error {
  readonly code = "VOICE_BIND_FAILED";

  constructor(message = "账号音色同步失败，请确认已登录桌面账号") {
    super(message);
    this.name = "SpeechAccountBindError";
  }
}

export async function isVolcengineSpeechConfigured() {
  const speech = await getSpeechRuntimeConfig();
  return speech.provider === "volcengine" && speech.available;
}

export async function isVolcengineTtsConfigured() {
  const speech = await getSpeechRuntimeConfig();
  return speech.provider === "volcengine" && speech.ttsAvailable;
}
