import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const TOKEN_COOKIE = "control_api_token";

function controlApiOrigin() {
  return (process.env.CONTROL_API_ORIGIN || "http://175.27.132.61").replace(/\/$/, "");
}

export async function forwardControlResume(path: string, init: RequestInit = {}) {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "请先在客户端登录后再管理简历" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${controlApiOrigin()}${path}`, {
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
