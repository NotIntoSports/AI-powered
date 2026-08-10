import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesizeWindowsSpeech } from "../../../lib/windows-tts";

export const runtime = "nodejs";

const requestSchema = z.object({
  text: z.string().trim().min(1).max(2000)
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "语音文本不能为空且不能超过 2000 字" },
      { status: 422 }
    );
  }
  try {
    const wav = await synthesizeWindowsSpeech(parsed.data.text);
    return new Response(new Uint8Array(wav), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (cause) {
    const unavailable = cause instanceof Error && cause.message === "SAPI_UNAVAILABLE";
    return NextResponse.json(
      {
        code: unavailable ? "TTS_UNAVAILABLE" : "TTS_FAILED",
        message: unavailable ? "当前系统不支持 Windows SAPI" : "本机中文语音合成失败"
      },
      { status: unavailable ? 501 : 500 }
    );
  }
}
