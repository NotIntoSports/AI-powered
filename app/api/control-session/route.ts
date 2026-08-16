import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TOKEN_COOKIE = "control_api_token";

function controlApiOrigin() {
  return (process.env.CONTROL_API_ORIGIN || "http://175.27.132.61").replace(/\/$/, "");
}

export async function GET() {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const response = await fetch(`${controlApiOrigin()}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ connected: true, user: body }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null) as { username?: string; password?: string } | null;
  const username = payload?.username?.trim() || "";
  const password = payload?.password || "";
  if (!username || !password) {
    return NextResponse.json({ code: "INVALID_INPUT", message: "请填写管理端用户名和密码" }, { status: 422 });
  }
  const response = await fetch(`${controlApiOrigin()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, purpose: "desktop", deviceId: "windows-desktop" }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => null) as { accessToken?: string; user?: unknown; message?: string; code?: string } | null;
  if (!response.ok || !body?.accessToken) {
    return NextResponse.json(
      { code: body?.code || "LOGIN_FAILED", message: body?.message || "管理端登录失败" },
      { status: response.status || 401 }
    );
  }
  const result = NextResponse.json({ connected: true, user: body.user }, { headers: { "Cache-Control": "no-store" } });
  result.cookies.set({
    name: TOKEN_COOKIE,
    value: body.accessToken,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8
  });
  return result;
}

export async function DELETE() {
  const result = NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  result.cookies.set({ name: TOKEN_COOKIE, value: "", httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return result;
}
