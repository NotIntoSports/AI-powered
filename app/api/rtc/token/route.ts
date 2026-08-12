import { NextResponse } from "next/server";
import { z } from "zod";
import { issueRtcToken } from "../../../../lib/rtc-settings";

const requestSchema = z.object({
  roomId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/),
  userId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/)
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_RTC_ID" }, { status: 422 });
  try {
    return NextResponse.json(await issueRtcToken(parsed.data.roomId, parsed.data.userId), {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (cause) {
    return NextResponse.json(
      { code: cause instanceof Error ? cause.message : "RTC_TOKEN_FAILED", message: "无法获取 RTC 短期 Token" },
      { status: 503 }
    );
  }
}
