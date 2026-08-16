import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  fetchDesktopControlJson,
  localSettingsDirectory,
  protectLocalSecret,
  unprotectLocalSecret
} from "./runtime-config";
import { DEFAULT_ASR_RESOURCE_ID, DEFAULT_TTS_RESOURCE_ID } from "./volcengine-speech";

const speechSettingsSchema = z.object({
  appId: z.string().max(200).default(""),
  speakerId: z.string().max(256).default(""),
  ttsResourceId: z.string().max(128).default(DEFAULT_TTS_RESOURCE_ID),
  asrResourceId: z.string().max(128).default(DEFAULT_ASR_RESOURCE_ID),
  encryptedApiKey: z.string().min(1).nullable().optional(),
  encryptedAccessToken: z.string().min(1).nullable().optional(),
  disabled: z.boolean().default(false)
});

type StoredSpeech = z.infer<typeof speechSettingsSchema>;

export type SpeechRuntimeConfig = {
  apiKey: string;
  appId: string;
  accessToken: string;
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
};

function emptySpeech(source: SpeechRuntimeConfig["source"] = "none"): SpeechRuntimeConfig {
  return {
    apiKey: "",
    appId: "",
    accessToken: "",
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
  appId?: string;
  speakerId?: string;
  ttsResourceId?: string;
  asrResourceId?: string;
  apiKey?: string;
  accessToken?: string;
}): SpeechRuntimeConfig | null {
  const config = withAvailability({
    apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
    appId: String(data.appId || ""),
    accessToken: typeof data.accessToken === "string" ? data.accessToken : "",
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
    appId?: string;
    speakerId?: string;
    ttsResourceId?: string;
    asrResourceId?: string;
    apiKey?: string;
    accessToken?: string;
  }>("/api/v1/client/settings/speech");
  if (!data) return null;
  return fromManagement(data);
}

export async function getSpeechRuntimeConfig(): Promise<SpeechRuntimeConfig> {
  const management = await getManagementSpeechConfig();
  const stored = await getStoredSpeech();
  if (management?.available) {
    return withAvailability({
      ...management,
      speakerId: management.speakerId || stored?.speakerId || ""
    });
  }
  if (stored && !stored.disabled) {
    let apiKey = "";
    let accessToken = "";
    if (stored.encryptedApiKey) {
      globalSpeech.decryptedSpeechApiKey ??= unprotectLocalSecret(stored.encryptedApiKey);
      apiKey = globalSpeech.decryptedSpeechApiKey;
    }
    if (stored.encryptedAccessToken) {
      globalSpeech.decryptedSpeechAccessToken ??= unprotectLocalSecret(stored.encryptedAccessToken);
      accessToken = globalSpeech.decryptedSpeechAccessToken;
    }
    const local = withAvailability({
      apiKey,
      appId: stored.appId,
      accessToken,
      speakerId: stored.speakerId,
      ttsResourceId: stored.ttsResourceId || DEFAULT_TTS_RESOURCE_ID,
      asrResourceId: stored.asrResourceId || DEFAULT_ASR_RESOURCE_ID,
      source: "settings"
    });
    if (local.available) return local;
  }
  const env = withAvailability({
    apiKey: process.env.VOLCENGINE_SPEECH_API_KEY || "",
    appId: process.env.VOLCENGINE_SPEECH_APP_ID || "",
    accessToken: process.env.VOLCENGINE_SPEECH_ACCESS_TOKEN || "",
    speakerId: process.env.VOLCENGINE_SPEECH_SPEAKER_ID || "",
    ttsResourceId: DEFAULT_TTS_RESOURCE_ID,
    asrResourceId: DEFAULT_ASR_RESOURCE_ID,
    source: "environment"
  });
  if (env.available) return env;
  if (management) return management;
  return emptySpeech(stored ? "settings" : "none");
}

export async function saveSpeechSpeakerId(speakerId: string) {
  const trimmed = speakerId.trim();
  const current = (await getStoredSpeech()) ?? speechSettingsSchema.parse({});
  await writeStoredSpeech({ ...current, speakerId: trimmed, disabled: false });
  await fetchDesktopControlJson("/api/v1/client/settings/speech", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speakerId: trimmed }),
    signal: AbortSignal.timeout(5_000)
  }).catch(() => null);
  return getSpeechRuntimeConfig();
}

export async function isVolcengineSpeechConfigured() {
  return (await getSpeechRuntimeConfig()).available;
}

export async function isVolcengineTtsConfigured() {
  return (await getSpeechRuntimeConfig()).ttsAvailable;
}
