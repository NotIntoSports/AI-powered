import { NextResponse } from "next/server";
import { z } from "zod";
import { loadRtcSettings, publicRtcSettings, saveRtcSettings } from "../../../../lib/rtc-settings";

const inputSchema = z.object({
  appId: z.string().trim().min(1).max(200),
  language: z.string().trim().min(2).max(20),
  mode: z.enum(["production", "trial"]),
  tokenServiceUrl: z.string().trim().max(500).optional(),
  trialToken: z.string().trim().max(4000).optional(),
  trialExpiresAt: z.string().trim().max(100).optional()
}).strict();

export async function GET() {
  return NextResponse.json(publicRtcSettings(await loadRtcSettings()), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_RTC_CONFIG", message: "RTC 配置不合法，且不能包含 AppKey" }, { status: 422 });
  }
  try {
    return NextResponse.json(publicRtcSettings(await saveRtcSettings(parsed.data)), {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "RTC_CONFIG_SAVE_FAILED";
    return NextResponse.json({ code, message: "无法安全保存 RTC 配置" }, { status: 422 });
  }
}
