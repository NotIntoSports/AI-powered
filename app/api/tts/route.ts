import { NextResponse } from "next/server";
import { z } from "zod";
import { getTtsRuntimeConfig, toAliyunNlsAuth } from "../../../lib/speech-runtime";
import { synthesizeAliyunSpeech } from "../../../lib/aliyun-nls";
import { isCosyVoiceSpeakerId, synthesizeCosyVoiceSpeech } from "../../../lib/aliyun-cosyvoice";
import {
  buildUnidirectionalTtsBody,
  concatTtsAudioChunks,
  VOLCENGINE_TTS_URL,
  volcengineJsonRequest
} from "../../../lib/volcengine-speech";
import { synthesizeWindowsSpeech } from "../../../lib/windows-tts";
import { formatPipelineLog } from "../../../lib/pipeline-diagnostics";

export const runtime = "nodejs";

const requestSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  traceId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    console.warn("[tts] invalid input");
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "语音文本不能为空且不能超过 2000 字" },
      { status: 422 }
    );
  }
  console.log(formatPipelineLog({
    event: "tts.requested",
    traceId: parsed.data.traceId,
    fields: { textLength: parsed.data.text.length }
  }));
  const wav = await synthesizeWithFallback(parsed.data.text, parsed.data.traceId);
  if (wav) {
    console.log(
      `[tts] ok textLen=${parsed.data.text.length} wavBytes=${wav.byteLength} elapsedMs=${Date.now() - startedAt}`
    );
    console.log(formatPipelineLog({
      event: "tts.succeeded",
      traceId: parsed.data.traceId,
      fields: { textLength: parsed.data.text.length, bytes: wav.byteLength, durationMs: Date.now() - startedAt }
    }));
    return new Response(new Uint8Array(wav), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
  console.warn(`[tts] unavailable textLen=${parsed.data.text.length} elapsedMs=${Date.now() - startedAt}`);
  console.warn(formatPipelineLog({
    event: "tts.failed",
    traceId: parsed.data.traceId,
    fields: { textLength: parsed.data.text.length, code: "TTS_UNAVAILABLE", durationMs: Date.now() - startedAt }
  }));
  return NextResponse.json(
    { code: "TTS_UNAVAILABLE", message: "当前没有可用的中文语音合成" },
    { status: 501 }
  );
}

async function synthesizeWithFallback(text: string, traceId?: string) {
  const speech = await getTtsRuntimeConfig();
  console.log(
    `[tts] provider=${speech.provider} ttsAvailable=${speech.ttsAvailable} speakerId=${speech.speakerId || "-"}`
  );
  console.log(formatPipelineLog({
    event: "tts.provider-selected",
    traceId,
    fields: { provider: speech.provider, status: speech.ttsAvailable ? "available" : "unavailable" }
  }));
  if (speech.provider === "aliyun" && speech.ttsAvailable) {
    try {
      // 复刻音色（cosyvoice-*）只能走 CosyVoice 大模型 WebSocket 合成，xiaoyun 等系统音色保持 HTTP 合成。
      if (isCosyVoiceSpeakerId(speech.speakerId)) {
        return await synthesizeCosyVoiceSpeech(toAliyunNlsAuth(speech), text);
      }
      return await synthesizeAliyunSpeech(toAliyunNlsAuth(speech), text);
    } catch (cause) {
      // Fall back to Windows SAPI.
      console.warn(`[tts] aliyun failed, falling back to SAPI: ${cause instanceof Error ? cause.message : cause}`);
    }
  }
  if (speech.provider === "volcengine" && speech.ttsAvailable) {
    try {
      const { response, text: raw } = await volcengineJsonRequest({
        url: VOLCENGINE_TTS_URL,
        auth: speech,
        body: buildUnidirectionalTtsBody(text, speech.speakerId),
        resourceId: speech.ttsResourceId,
        timeoutMs: 30_000
      });
      if (response.ok) return concatTtsAudioChunks(raw);
      console.warn(`[tts] volcengine responded ${response.status}, falling back to SAPI`);
    } catch (cause) {
      // Fall back to Windows SAPI.
      console.warn(`[tts] volcengine failed, falling back to SAPI: ${cause instanceof Error ? cause.message : cause}`);
    }
  }
  try {
    return await synthesizeWindowsSpeech(text);
  } catch (cause) {
    console.warn(`[tts] SAPI fallback failed: ${cause instanceof Error ? cause.message : cause}`);
    return null;
  }
}
