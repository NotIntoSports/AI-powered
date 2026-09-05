import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseControlApiResponse, type ControlApiResult } from "./control-api-result";

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "settings");
const dpapiScript = path.join(process.cwd(), "scripts", "dpapi-secret.ps1");
const TOKEN_COOKIE = "desktop_session";

function runDpapi(mode: "Protect" | "Unprotect", value: string) {
  if (process.platform !== "win32") throw new Error("DPAPI_UNAVAILABLE");
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

export function controlApiOrigin() {
  return (process.env.BACKEND_ORIGIN || "").replace(/\/$/, "");
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
  const origin = controlApiOrigin();
  if (!origin) return { ok: false, failure: { status: 0, code: "BACKEND_UNCONFIGURED", message: "" } };
  try {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${origin}${path}`, {
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
  const origin = controlApiOrigin();
  if (!origin) return { reachable: false, rttMs: 0 };
  try {
    const response = await fetch(`${origin}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500)
    });
    return { reachable: response.ok, rttMs: Date.now() - started };
  } catch {
    return { reachable: false, rttMs: Date.now() - started };
  }
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
