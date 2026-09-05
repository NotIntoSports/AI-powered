import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const TOKEN_COOKIE = "desktop_session";

function backendOrigin() {
  return (process.env.BACKEND_ORIGIN || "").replace(/\/$/, "");
}

export async function forwardControlResume(path: string, init: RequestInit = {}) {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "请先在客户端登录后再管理资料" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const origin = backendOrigin();
  if (!origin) {
    return NextResponse.json(
      { code: "BACKEND_UNCONFIGURED", message: "未配置本机后端地址" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    cache: "no-store"
  });
  if (response.status === 204) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" }
    });
  }
  const payload = await response.json().catch(() => null);
  return NextResponse.json(payload, {
    status: response.status,
    headers: { "Cache-Control": "no-store" }
  });
}
