import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const TOKEN_COOKIE = "control_api_token";
const requestSchema = z.object({
  roomId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/),
  userId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/)
});

function controlApiOrigin() {
  return (process.env.CONTROL_API_ORIGIN || "http://175.27.132.61").replace(/\/$/, "");
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_RTC_ID" }, { status: 422 });
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { code: "RTC_TOKEN_FAILED", message: "请先登录后再获取 LiveKit Token" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const response = await fetch(`${controlApiOrigin()}/api/v1/client/rtc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(parsed.data),
    cache: "no-store"
  });
  const body = await response.json().catch(() => null);
  if (response.ok) {
    console.log(`[rtc-token] path=control-api status=${response.status} provider=${body?.provider || "livekit"} roomId=${body?.roomId || ""} url=${body?.url || ""}`);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }
  console.warn(`[rtc-token] path=control-api status=${response.status} code=${body?.code || "unknown"}`);
  return NextResponse.json(
    { code: body?.code || "RTC_TOKEN_FAILED", message: body?.message || "无法获取 LiveKit Token" },
    { status: response.status, headers: { "Cache-Control": "no-store" } }
  );
}
