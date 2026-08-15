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
    lastLoginAt: typeof record.lastLoginAt === "string" ? record.lastLoginAt : undefined
  };
}

export function displayError(error: APIError): string {
  return error.message;
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
