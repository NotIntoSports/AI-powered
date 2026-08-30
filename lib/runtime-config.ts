import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { isSecureEndpoint } from "./endpoint-security";
import { parseControlApiResponse, type ControlApiResult } from "./control-api-result";

const settingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().max(200),
  encryptedApiKey: z.string().min(1).nullable(),
  disabled: z.boolean().default(false)
});

type StoredSettings = z.infer<typeof settingsSchema>;

export type ModelRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "management" | "settings" | "environment" | "default";
  questionTimeoutMs?: number;
  reportTimeoutMs?: number;
};

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "settings");
const settingsPath = path.join(dataDirectory, "model.json");
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");

type ClientPipelinePayload = {
  mode?: string;
  message?: string;
  voice?: string;
  llm?: { baseUrl?: string; modelId?: string; apiKey?: string; providerName?: string };
  asr?: { baseUrl?: string; modelId?: string; apiKey?: string };
  tts?: { modelId?: string; providerId?: string };
  e2e?: { baseUrl?: string; modelId?: string; apiKey?: string };
};

const globalConfig = globalThis as typeof globalThis & {
  modelSettingsPromise?: Promise<StoredSettings | null>;
  decryptedModelKey?: string;
  managementModelCache?: { token: string; at: number; config: ModelRuntimeConfig };
  pipelineCache?: { token: string; at: number; pipeline: ClientPipelinePayload | null };
};

export async function getClientPipeline(): Promise<ClientPipelinePayload | null> {
  const token = await readDesktopToken();
  if (!token) return null;
  const cached = globalConfig.pipelineCache;
  if (cached && cached.token === token && Date.now() - cached.at < 5_000) {
    return cached.pipeline;
  }
  const data = await fetchDesktopControlJson<ClientPipelinePayload>("/api/v1/client/settings/pipeline");
  globalConfig.pipelineCache = { token, at: Date.now(), pipeline: data };
  return data;
}

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

const TOKEN_COOKIE = "control_api_token";

export function controlApiOrigin() {
  return (process.env.CONTROL_API_ORIGIN || "http://175.27.132.61").replace(/\/$/, "");
}

async function readDesktopToken() {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(TOKEN_COOKIE)?.value || "";
  } catch {
    return "";
  }
}

export async function fetchDesktopControlJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const result = await fetchDesktopControlResult<T>(path, init);
  return result.ok ? result.data : null;
}

export async function fetchDesktopControlResult<T>(path: string, init?: RequestInit): Promise<ControlApiResult<T>> {
  const token = await readDesktopToken();
  if (!token) return { ok: false, failure: { status: 401, code: "AUTH_REQUIRED", message: "" } };
  try {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${controlApiOrigin()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(5_000)
    });
    return await parseControlApiResponse<T>(response);
  } catch {
    return { ok: false, failure: { status: 0, code: "NETWORK_ERROR", message: "" } };
  }
}

export async function pingControlApi() {
  const started = Date.now();
  try {
    const response = await fetch(`${controlApiOrigin()}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500)
    });
    return { reachable: response.ok, rttMs: Date.now() - started };
  } catch {
    return { reachable: false, rttMs: Date.now() - started };
  }
}

async function getManagementModelConfig(): Promise<ModelRuntimeConfig | null> {
  const token = await readDesktopToken();
  if (!token) return null;
  const cached = globalConfig.managementModelCache;
  if (cached && cached.token === token && Date.now() - cached.at < 5_000) {
    return cached.config;
  }
  const pipeline = await getClientPipeline();
  if (pipeline?.mode === "e2e") {
    // Explicit error — never silently fall back to cascaded / local LLM.
    if (pipeline.message === "E2E_NOT_IMPLEMENTED" || !pipeline.e2e?.baseUrl || !pipeline.e2e.modelId) {
      throw new Error("E2E_NOT_IMPLEMENTED");
    }
    const config: ModelRuntimeConfig = {
      apiKey: pipeline.e2e.apiKey || "",
      baseUrl: String(pipeline.e2e.baseUrl || "").replace(/\/$/, ""),
      model: String(pipeline.e2e.modelId || ""),
      source: "management"
    };
    globalConfig.managementModelCache = { token, at: Date.now(), config };
    return config;
  }
  if (pipeline?.llm?.baseUrl && pipeline.llm.modelId) {
    const config: ModelRuntimeConfig = {
      apiKey: pipeline.llm.apiKey || "",
      baseUrl: String(pipeline.llm.baseUrl || "").replace(/\/$/, ""),
      model: String(pipeline.llm.modelId || ""),
      source: "management"
    };
    globalConfig.managementModelCache = { token, at: Date.now(), config };
    return config;
  }
  const data = await fetchDesktopControlJson<{
    available?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    questionTimeoutMs?: number;
    reportTimeoutMs?: number;
  }>("/api/v1/client/settings/ai");
  if (!data) return null;
  const config: ModelRuntimeConfig = {
    apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
    baseUrl: String(data.baseUrl || "").replace(/\/$/, ""),
    model: String(data.model || ""),
    source: "management",
    questionTimeoutMs: Number(data.questionTimeoutMs || 0) || undefined,
    reportTimeoutMs: Number(data.reportTimeoutMs || 0) || undefined
  };
  globalConfig.managementModelCache = { token, at: Date.now(), config };
  return config;
}

export async function getModelRuntimeConfig(): Promise<ModelRuntimeConfig> {
  const management = await getManagementModelConfig();
  if (management) return management;
  const stored = await getStoredSettings();
  if (stored) {
    if (stored.disabled) {
      return { apiKey: "", baseUrl: stored.baseUrl, model: "", source: "settings" };
    }
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
    encryptedApiKey,
    disabled: false
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
  const settings = settingsSchema.parse({
    baseUrl: "https://api.openai.com/v1",
    model: "",
    encryptedApiKey: null,
    disabled: true
  });
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
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
  return Boolean(config.model) && (Boolean(config.apiKey) || isLocalModelEndpoint(config.baseUrl));
}

export function protectLocalSecret(value: string) {
  return runDpapi("Protect", value);
}

export function unprotectLocalSecret(value: string) {
  return runDpapi("Unprotect", value);
}

export function localSettingsDirectory() {
  return dataDirectory;
}
