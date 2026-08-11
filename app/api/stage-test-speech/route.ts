import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getStageTestSpeech,
  queueStageTestSpeech
} from "../../../lib/stage-status";

const requestSchema = z.object({
  text: z.string().trim().min(1).max(500)
});

export async function GET() {
  return NextResponse.json(getStageTestSpeech(), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "测试语音内容无效" },
      { status: 422 }
    );
  }
  return NextResponse.json(queueStageTestSpeech(parsed.data.text));
}
