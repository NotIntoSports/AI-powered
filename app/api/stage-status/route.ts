import { NextResponse } from "next/server";
import { z } from "zod";
import { getStageStatus, requestStageSpeechStop, updateStageStatus } from "../../../lib/stage-status";

// 合并式上报：舞台页上报 TTS 字段，主控台上报采集字段，至少携带一项。
const statusSchema = z
  .object({
    ttsSupported: z.boolean(),
    voiceCount: z.number().int().min(0).max(1000),
    ttsState: z.enum(["idle", "speaking", "ready", "error"]),
    ttsError: z.string().max(200),
    lastSpeechAt: z.number().int().min(0),
    mediaReady: z.boolean(),
    captureState: z.enum(["off", "capturing", "silent"]),
    captureSource: z.string().max(200)
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "至少上报一项状态" });

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

export async function PUT() {
  return NextResponse.json({ ok: true, stopSpeechAt: requestStageSpeechStop() });
}
