export type ControlUser = { username?: string; role?: string };

export type ControlSession = {
  connected: boolean;
  user: ControlUser | null;
};

function sessionFromUnknown(data: unknown): ControlSession {
  if (!data || typeof data !== "object") {
    return { connected: false, user: null };
  }
  const payload = data as { connected?: unknown; user?: ControlUser | null };
  return {
    connected: Boolean(payload.connected),
    user: payload.user && typeof payload.user === "object" ? payload.user : null
  };
}

export async function readControlSession(): Promise<ControlSession> {
  const response = await fetch("/api/control-session", { cache: "no-store" });
  const data = await response.json().catch(() => null);
  return sessionFromUnknown(data);
}

export async function loginControlSession(username: string, password: string): Promise<{
  ok: boolean;
  session: ControlSession;
  message?: string;
}> {
  const response = await fetch("/api/control-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      session: { connected: false, user: null },
      message: response.status === 429 ? "尝试次数过多，请稍后再试" : "登录失败"
    };
  }
  return { ok: true, session: { connected: true, user: sessionFromUnknown(data).user } };
}

export async function logoutControlSession(): Promise<void> {
  await fetch("/api/control-session", { method: "DELETE" });
}
