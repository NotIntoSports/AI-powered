import { NextResponse } from "next/server";
import { z } from "zod";
import { getStageStatus, updateStageStatus } from "../../../lib/stage-status";

const statusSchema = z.object({
  ttsSupported: z.boolean(),
  voiceCount: z.number().int().min(0).max(1000),
  ttsState: z.enum(["idle", "speaking", "ready", "error"]),
  ttsError: z.string().max(200),
  lastSpeechAt: z.number().int().min(0),
  mediaReady: z.boolean()
});

export async function GET() {
  return NextResponse.json(getStageStatus(), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request) {
  const parsed = statusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "舞台状态数据无效" },
      { status: 422 }
    );
  }
  updateStageStatus(parsed.data);
  return NextResponse.json({ ok: true });
}
