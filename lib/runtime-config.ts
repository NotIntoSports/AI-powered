import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { isSecureEndpoint } from "./endpoint-security";
import {
  dataRoot,
  getSetting,
  hasMigration,
  markMigrationComplete,
  setSetting
} from "./database";

const settingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
  encryptedApiKey: z.string().min(1).nullable()
});

type StoredSettings = z.infer<typeof settingsSchema>;

export type ModelRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "settings" | "environment" | "default";
};

const legacySettingsPaths = [
  path.join(dataRoot, "settings", "model.json"),
  path.join(dataRoot, "model.json")
];
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");

const globalConfig = globalThis as typeof globalThis & {
  modelSettingsPromise?: Promise<StoredSettings | null>;
  decryptedModelKey?: string;
};

export function runDpapi(mode: "Protect" | "Unprotect", value: string) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI_UNAVAILABLE");
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", dpapiScript, "-Mode", mode],
    {
      input: value,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
  );
  if (result.status !== 0) throw new Error("DPAPI_FAILED");
  return result.stdout.trim();
}

async function loadStoredSettings() {
  const stored = getSetting("model");
  if (stored) {
    try {
      return settingsSchema.parse(JSON.parse(stored));
    } catch {
      console.warn("Stored model settings are invalid; ignoring them.");
      return null;
    }
  }
  if (hasMigration("model-json")) return null;
  for (const legacyPath of legacySettingsPaths) {
    try {
      const settings = settingsSchema.parse(JSON.parse(await readFile(legacyPath, "utf8")));
      setSetting("model", JSON.stringify(settings));
      markMigrationComplete("model-json");
      return settings;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Legacy model settings could not be imported from ${path.basename(legacyPath)}.`);
      }
    }
  }
  markMigrationComplete("model-json");
  return null;
}

async function getStoredSettings() {
  globalConfig.modelSettingsPromise ??= loadStoredSettings();
  return globalConfig.modelSettingsPromise;
}

export async function getModelRuntimeConfig(): Promise<ModelRuntimeConfig> {
  const stored = await getStoredSettings();
  if (stored) {
    let apiKey = "";
    if (stored.encryptedApiKey) {
      globalConfig.decryptedModelKey ??= runDpapi("Unprotect", stored.encryptedApiKey);
      apiKey = globalConfig.decryptedModelKey;
    }
    return {
      apiKey,
      baseUrl: stored.baseUrl.replace(/\/$/, ""),
      model: stored.model,
      source: "settings"
    };
  }
  const apiKey = process.env.OPENAI_API_KEY || "";
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    source: apiKey ? "environment" : "default"
  };
}

export async function saveModelRuntimeConfig(input: {
  apiKey?: string;
  baseUrl: string;
  model: string;
}) {
  const current = await getStoredSettings();
  const currentRuntime = await getModelRuntimeConfig();
  const localEndpoint = isLocalModelEndpoint(input.baseUrl);
  const encryptedApiKey = input.apiKey
    ? runDpapi("Protect", input.apiKey)
    : localEndpoint
      ? null
      : current?.encryptedApiKey ??
      (currentRuntime.apiKey ? runDpapi("Protect", currentRuntime.apiKey) : null);
  const settings = settingsSchema.parse({
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    model: input.model,
    encryptedApiKey
  });
  setSetting("model", JSON.stringify(settings));
  globalConfig.decryptedModelKey = input.apiKey ||
    (localEndpoint ? undefined : currentRuntime.apiKey || undefined);
  globalConfig.modelSettingsPromise = Promise.resolve(settings);
  return getModelRuntimeConfig();
}

export async function clearModelRuntimeConfig() {
  const settings = settingsSchema.parse({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    encryptedApiKey: null
  });
  setSetting("model", JSON.stringify(settings));
  globalConfig.decryptedModelKey = undefined;
  globalConfig.modelSettingsPromise = Promise.resolve(settings);
}

export function isSecureModelEndpoint(value: string) {
  return isSecureEndpoint(value);
}

export function isLocalModelEndpoint(value: string) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isModelRuntimeConfigured(config: ModelRuntimeConfig) {
  return Boolean(config.apiKey) || isLocalModelEndpoint(config.baseUrl);
}
