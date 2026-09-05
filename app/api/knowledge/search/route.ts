import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TOKEN_COOKIE = "desktop_session";

function backendOrigin() {
  return (process.env.BACKEND_ORIGIN || "").replace(/\/$/, "");
}

export async function POST(request: Request) {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "请先在客户端登录后再检索资料" },
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
  const payload = await request.json().catch(() => null);
  const response = await fetch(`${origin}/api/v1/client/knowledge/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload ?? {}),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({ chunks: [] }));
  return NextResponse.json(body, {
    status: response.status,
    headers: { "Cache-Control": "no-store" }
  });
}
