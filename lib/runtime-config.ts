import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { isSecureEndpoint } from "./endpoint-security";

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

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "settings");
const settingsPath = path.join(dataDirectory, "model.json");
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");

const globalConfig = globalThis as typeof globalThis & {
  modelSettingsPromise?: Promise<StoredSettings | null>;
  decryptedModelKey?: string;
};

function runDpapi(mode: "Protect" | "Unprotect", value: string) {
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
  try {
    return settingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
  } catch {
    return null;
  }
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
    model: process.env.OPENAI_MODEL || "",
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
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
  globalConfig.decryptedModelKey = input.apiKey ||
    (localEndpoint ? undefined : currentRuntime.apiKey || undefined);
  globalConfig.modelSettingsPromise = Promise.resolve(settings);
  return getModelRuntimeConfig();
}

export async function clearModelRuntimeConfig() {
  await rm(settingsPath, { force: true });
  globalConfig.decryptedModelKey = undefined;
  globalConfig.modelSettingsPromise = Promise.resolve(null);
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
  return Boolean(config.model) && (Boolean(config.apiKey) || isLocalModelEndpoint(config.baseUrl));
}
