import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_CLONE_AUDIO_BYTES } from "../../../lib/pcm-wav";
import { getSpeechRuntimeConfig, saveSpeechSpeakerId, SpeechAccountBindError } from "../../../lib/speech-runtime";
import { VOICE_CLONE_SCRIPT, DEFAULT_CUSTOM_SPEAKER_ID } from "../../../lib/voice-clone-script";
import {
  buildVoiceCloneBody,
  parseVoiceCloneSpeakerId,
  resolveCloneSpeaker,
  VOLCENGINE_CLONE_URL,
  volcengineJsonRequest
} from "../../../lib/volcengine-speech";

export const runtime = "nodejs";
export const maxDuration = 60;

const postSchema = z.object({
  audioBase64: z.string().min(1).max(14_000_000).optional(),
  format: z.enum(["wav", "mp3", "ogg", "m4a", "aac", "pcm"]).optional(),
  speakerId: z.string().trim().max(256).optional()
});

export async function GET() {
  const speech = await getSpeechRuntimeConfig();
  return NextResponse.json({
    available: speech.provider === "volcengine" && speech.available,
    ttsAvailable: speech.ttsAvailable,
    asrAvailable: speech.asrAvailable,
    speakerId: speech.speakerId,
    source: speech.source,
    provider: speech.provider
  });
}

export async function POST(request: Request) {
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "录音数据无效" },
      { status: 422 }
    );
  }
  const speech = await getSpeechRuntimeConfig();
  if (speech.provider !== "volcengine" || !speech.available) {
    return NextResponse.json(
      {
        code: "SPEECH_UNAVAILABLE",
        message: speech.provider === "aliyun"
          ? "当前使用阿里云语音。声音复刻仍需配置豆包语音"
          : "请先在管理后台或本机环境变量配置豆包语音密钥"
      },
      { status: 503 }
    );
  }

  if (!parsed.data.audioBase64) {
    const speakerId = parsed.data.speakerId?.trim() || "";
    if (!speakerId) {
      return NextResponse.json(
        { code: "INVALID_INPUT", message: "请先录音，或粘贴已有音色 ID" },
        { status: 422 }
      );
    }
    return bindSpeakerId(speakerId, false);
  }

  const audioBytes = Buffer.from(parsed.data.audioBase64, "base64");
  if (!audioBytes.length || audioBytes.length > MAX_CLONE_AUDIO_BYTES) {
    return NextResponse.json(
      { code: "INVALID_AUDIO_SIZE", message: "录音不能为空且不能超过 10MB" },
      { status: 413 }
    );
  }

  const speakerHint = parsed.data.speakerId?.trim() || speech.speakerId || DEFAULT_CUSTOM_SPEAKER_ID;
  const body = buildVoiceCloneBody({
    audioBase64: parsed.data.audioBase64,
    format: parsed.data.format || "wav",
    text: VOICE_CLONE_SCRIPT,
    speakerId: speakerHint
  });

  try {
    const { response, text } = await volcengineJsonRequest({
      url: VOLCENGINE_CLONE_URL,
      auth: speech,
      body,
      timeoutMs: 60_000
    });
    const payload = parseJson(text);
    if (!response.ok) {
      return NextResponse.json(
        {
          code: "VOICE_CLONE_FAILED",
          message: cloneErrorMessage(payload, response.status)
        },
        { status: 502 }
      );
    }
    const fallback = resolveCloneSpeaker(speakerHint).custom_speaker_id || speakerHint;
    const speakerId = parseVoiceCloneSpeakerId(payload, fallback);
    if (!speakerId) {
      return NextResponse.json(
        { code: "VOICE_CLONE_FAILED", message: "声音刻录未返回音色 ID" },
        { status: 502 }
      );
    }
    return bindSpeakerId(speakerId, true);
  } catch {
    return NextResponse.json(
      { code: "VOICE_CLONE_FAILED", message: "声音刻录失败，请检查网络和语音配置" },
      { status: 502 }
    );
  }
}

async function bindSpeakerId(speakerId: string, cloned: boolean) {
  try {
    await saveSpeechSpeakerId(speakerId);
    return NextResponse.json({ speakerId, cloned, bound: true });
  } catch (error) {
    if (error instanceof SpeechAccountBindError) {
      return NextResponse.json(
        {
          code: error.code,
          message: error.message,
          speakerId,
          cloned,
          bound: false
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      {
        code: "VOICE_BIND_FAILED",
        message: "账号音色同步失败，请确认已登录桌面账号",
        speakerId,
        cloned,
        bound: false
      },
      { status: 502 }
    );
  }
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cloneErrorMessage(payload: Record<string, unknown> | null, status: number) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (message) return "声音刻录失败，请换安静环境后按稿再录一次";
  if (status === 401 || status === 403) return "豆包语音鉴权失败，请检查管理端密钥";
  return "声音刻录失败，请检查网络和语音配置";
}
