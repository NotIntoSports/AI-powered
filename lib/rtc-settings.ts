import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const storedSchema = z.object({
  appId: z.string().min(1).max(200),
  language: z.string().min(2).max(20),
  mode: z.enum(["production", "trial"]),
  tokenServiceUrl: z.string().url().nullable(),
  encryptedTrialToken: z.string().nullable(),
  trialExpiresAt: z.string().datetime().nullable()
});

export type RtcSettingsInput = {
  appId: string;
  language: string;
  mode: "production" | "trial";
  tokenServiceUrl?: string;
  trialToken?: string;
  trialExpiresAt?: string;
};

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "settings");
const settingsPath = path.join(dataDirectory, "rtc.json");
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");

function protect(value: string): string {
  if (process.platform !== "win32") throw new Error("DPAPI_UNAVAILABLE");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", dpapiScript, "-Mode", "Protect"],
    { input: value, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error("DPAPI_FAILED");
  return result.stdout.trim();
}

export async function loadRtcSettings() {
  try { return storedSchema.parse(JSON.parse(await readFile(settingsPath, "utf8"))); }
  catch { return null; }
}

export async function saveRtcSettings(input: RtcSettingsInput) {
  const production = input.mode === "production";
  if (production) {
    const url = new URL(input.tokenServiceUrl || "");
    if (url.protocol !== "https:") throw new Error("TOKEN_SERVICE_REQUIRES_HTTPS");
  } else {
    if (!input.trialToken?.trim()) throw new Error("TRIAL_TOKEN_REQUIRED");
    if (!input.trialExpiresAt || Date.parse(input.trialExpiresAt) <= Date.now()) {
      throw new Error("TRIAL_TOKEN_EXPIRED");
    }
  }
  const stored = storedSchema.parse({
    appId: input.appId,
    language: input.language,
    mode: input.mode,
    tokenServiceUrl: production ? input.tokenServiceUrl : null,
    encryptedTrialToken: production ? null : protect(input.trialToken!.trim()),
    trialExpiresAt: production ? null : new Date(input.trialExpiresAt!).toISOString()
  });
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
  return stored;
}

export function publicRtcSettings(settings: Awaited<ReturnType<typeof loadRtcSettings>>) {
  return settings ? {
    configured: true,
    appId: settings.appId,
    language: settings.language,
    mode: settings.mode,
    tokenServiceUrl: settings.tokenServiceUrl,
    trialTokenConfigured: Boolean(settings.encryptedTrialToken),
    trialExpiresAt: settings.trialExpiresAt
  } : {
    configured: false,
    appId: "",
    language: "zh",
    mode: "production" as const,
    tokenServiceUrl: "",
    trialTokenConfigured: false,
    trialExpiresAt: null
  };
}
