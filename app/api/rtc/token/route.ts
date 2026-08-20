import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { issueRtcToken } from "../../../../lib/rtc-settings";

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
  if (token) {
    const response = await fetch(`${controlApiOrigin()}/api/v1/client/rtc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(parsed.data),
      cache: "no-store"
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      console.log(`[rtc-token] path=control-api status=${response.status} provider=${body?.provider || "unknown"} roomId=${body?.roomId || ""} urlPresent=${Boolean(body?.url)}`);
      return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
    }
    console.warn(`[rtc-token] path=control-api status=${response.status} code=${body?.code || "unknown"}${response.status === 503 || response.status === 404 ? " fallback=local" : ""}`);
    if (response.status !== 503 && response.status !== 404) {
      return NextResponse.json(
        { code: body?.code || "RTC_TOKEN_FAILED", message: body?.message || "无法获取 RTC 短期 Token" },
        { status: response.status, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
  if (!token) console.warn("[rtc-token] path=local-fallback reason=no-control-api-cookie");
  try {
    const issued = await issueRtcToken(parsed.data.roomId, parsed.data.userId);
    console.log(`[rtc-token] path=local-fallback status=ok provider=${issued.provider} roomId=${issued.roomId}`);
    return NextResponse.json(issued, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (cause) {
    console.error(`[rtc-token] path=local-fallback status=503 code=${cause instanceof Error ? cause.message : "RTC_TOKEN_FAILED"}`);
    return NextResponse.json(
      { code: cause instanceof Error ? cause.message : "RTC_TOKEN_FAILED", message: "无法获取 RTC 短期 Token" },
      { status: 503 }
    );
  }
}
