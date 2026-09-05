import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TOKEN_COOKIE = "desktop_session";

function backendOrigin() {
  return (process.env.BACKEND_ORIGIN || "").replace(/\/$/, "");
}

export async function GET() {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const origin = backendOrigin();
  if (!origin) {
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const response = await fetch(`${origin}/api/v1/auth/me`, {
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
    return NextResponse.json({ code: "INVALID_INPUT", message: "请填写客户端账号和密码" }, { status: 422 });
  }
  const origin = backendOrigin();
  if (!origin) {
    return NextResponse.json(
      { code: "BACKEND_UNCONFIGURED", message: "未配置本机后端地址" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, purpose: "desktop" }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => null) as { accessToken?: string; user?: unknown } | null;
  if (!response.ok || !body?.accessToken) {
    return NextResponse.json(
      { code: "LOGIN_FAILED", message: response.status === 429 ? "尝试次数过多，请稍后再试" : "登录失败" },
      { status: response.status === 429 ? 429 : 401, headers: { "Cache-Control": "no-store" } }
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
