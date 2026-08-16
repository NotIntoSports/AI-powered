import { NextResponse } from "next/server";
import { z } from "zod";
import { getSpeechRuntimeConfig } from "../../../lib/speech-runtime";
import {
  buildUnidirectionalTtsBody,
  concatTtsAudioChunks,
  VOLCENGINE_TTS_URL,
  volcengineJsonRequest
} from "../../../lib/volcengine-speech";
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
  const wav = await synthesizeWithFallback(parsed.data.text);
  if (wav) {
    return new Response(new Uint8Array(wav), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
  return NextResponse.json(
    { code: "TTS_UNAVAILABLE", message: "当前没有可用的中文语音合成" },
    { status: 501 }
  );
}

async function synthesizeWithFallback(text: string) {
  const speech = await getSpeechRuntimeConfig();
  if (speech.ttsAvailable) {
    try {
      const { response, text: raw } = await volcengineJsonRequest({
        url: VOLCENGINE_TTS_URL,
        auth: speech,
        body: buildUnidirectionalTtsBody(text, speech.speakerId),
        resourceId: speech.ttsResourceId,
        timeoutMs: 30_000
      });
      if (response.ok) return concatTtsAudioChunks(raw);
    } catch {
      // Fall back to Windows SAPI.
    }
  }
  try {
    return await synthesizeWindowsSpeech(text);
  } catch {
    return null;
  }
}
