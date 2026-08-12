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
  trialExpiresAt: z.string().datetime().nullable(),
  trialRoomId: z.string().nullable().default(null),
  trialUserId: z.string().nullable().default(null)
});

export type RtcSettingsInput = {
  appId: string;
  language: string;
  mode: "production" | "trial";
  tokenServiceUrl?: string;
  trialToken?: string;
  trialExpiresAt?: string;
  trialRoomId?: string;
  trialUserId?: string;
};

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "settings");
const settingsPath = path.join(dataDirectory, "rtc.json");
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");

function runDpapi(mode: "Protect" | "Unprotect", value: string): string {
  if (process.platform !== "win32") throw new Error("DPAPI_UNAVAILABLE");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", dpapiScript, "-Mode", mode],
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
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.trialRoomId || "") ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.trialUserId || "")) {
      throw new Error("TRIAL_RTC_ID_REQUIRED");
    }
  }
  const stored = storedSchema.parse({
    appId: input.appId,
    language: input.language,
    mode: input.mode,
    tokenServiceUrl: production ? input.tokenServiceUrl : null,
    encryptedTrialToken: production ? null : runDpapi("Protect", input.trialToken!.trim()),
    trialExpiresAt: production ? null : new Date(input.trialExpiresAt!).toISOString(),
    trialRoomId: production ? null : input.trialRoomId,
    trialUserId: production ? null : input.trialUserId
  });
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
  return stored;
}

export async function issueRtcToken(roomId: string, userId: string) {
  const settings = await loadRtcSettings();
  if (!settings) throw new Error("RTC_NOT_CONFIGURED");
  if (settings.mode === "trial") {
    if (!settings.encryptedTrialToken || !settings.trialExpiresAt || !settings.trialRoomId || !settings.trialUserId || Date.parse(settings.trialExpiresAt) <= Date.now()) {
      throw new Error("RTC_TRIAL_TOKEN_EXPIRED");
    }
    return {
      appId: settings.appId,
      token: runDpapi("Unprotect", settings.encryptedTrialToken),
      expiresAt: settings.trialExpiresAt,
      language: settings.language,
      roomId: settings.trialRoomId,
      userId: settings.trialUserId
    };
  }
  if (!settings.tokenServiceUrl) throw new Error("RTC_TOKEN_SERVICE_MISSING");
  const response = await fetch(settings.tokenServiceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: settings.appId, roomId, userId }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("RTC_TOKEN_SERVICE_FAILED");
  const payload = z.object({ token: z.string().min(1), expiresAt: z.string().datetime() }).parse(await response.json());
  return { appId: settings.appId, token: payload.token, expiresAt: payload.expiresAt, language: settings.language, roomId, userId };
}

export function publicRtcSettings(settings: Awaited<ReturnType<typeof loadRtcSettings>>) {
  return settings ? {
    configured: true,
    appId: settings.appId,
    language: settings.language,
    mode: settings.mode,
    tokenServiceUrl: settings.tokenServiceUrl,
    trialTokenConfigured: Boolean(settings.encryptedTrialToken),
    trialExpiresAt: settings.trialExpiresAt,
    trialRoomId: settings.trialRoomId,
    trialUserId: settings.trialUserId
  } : {
    configured: false,
    appId: "",
    language: "zh",
    mode: "production" as const,
    tokenServiceUrl: "",
    trialTokenConfigured: false,
    trialExpiresAt: null,
    trialRoomId: "",
    trialUserId: ""
  };
}
