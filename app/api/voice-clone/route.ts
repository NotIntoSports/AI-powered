import { NextResponse } from "next/server";
import { z } from "zod";
import { cloneCosyVoice, COSYVOICE_MAX_CLONE_SECONDS, COSYVOICE_VOICE_PREFIX, isCosyVoiceSpeakerId } from "../../../lib/aliyun-cosyvoice";
import { MAX_CLONE_AUDIO_BYTES, truncateWavToSeconds } from "../../../lib/pcm-wav";
import { fetchDesktopControlJson, fetchDesktopControlResult } from "../../../lib/runtime-config";
import { voiceSampleUploadFailureMessage } from "../../../lib/voice-sample-errors";
import {
  getSpeechRuntimeConfig,
  getTtsRuntimeConfig,
  getVolcengineSpeechConfig,
  isClonedSpeakerId,
  saveSpeechSpeakerId,
  SpeechAccountBindError
} from "../../../lib/speech-runtime";
import { DEFAULT_CUSTOM_SPEAKER_ID, VOICE_CLONE_SCRIPT } from "../../../lib/voice-clone-script";
import {
  buildVoiceCloneBody,
  isVoiceCloneBusinessError,
  parseVoiceCloneSpeakerId,
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
  const volcengine = await getVolcengineSpeechConfig();
  const tts = await getTtsRuntimeConfig();
  const volcSpeakerId = tts.provider === "volcengine" && isClonedSpeakerId(tts.speakerId)
    ? tts.speakerId
    : volcengine && isClonedSpeakerId(volcengine.speakerId)
      ? volcengine.speakerId
      : "";
  const aliyunSpeakerId = !volcSpeakerId && tts.provider === "aliyun" && isCosyVoiceSpeakerId(tts.speakerId)
    ? tts.speakerId
    : "";
  const speakerId = volcSpeakerId || aliyunSpeakerId;
  const aliyunCloneReady = speech.provider === "aliyun"
    && Boolean(speech.appId && speech.accessKeyId && speech.accessKeySecret);
  return NextResponse.json({
    available: Boolean(volcengine?.available) || aliyunCloneReady,
    aliyunCloneReady,
    ttsAvailable: tts.ttsAvailable,
    asrAvailable: speech.asrAvailable,
    speakerId,
    cloned: Boolean(speakerId),
    enabled: Boolean(speakerId && (tts.provider === "volcengine" || isCosyVoiceSpeakerId(speakerId))),
    source: tts.source,
    provider: tts.provider
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
  const volcengine = await getVolcengineSpeechConfig();
  const speech = await getSpeechRuntimeConfig();
  const aliyunCloneReady = speech.provider === "aliyun"
    && Boolean(speech.appId && speech.accessKeyId && speech.accessKeySecret);
  if (!volcengine?.available && !aliyunCloneReady) {
    return NextResponse.json(
      {
        code: "SPEECH_UNAVAILABLE",
        message: "请先在管理后台配置豆包或阿里云语音密钥后再刻录"
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

  if (!volcengine?.available) {
    return cloneWithAliyun(speech, audioBytes);
  }

  const speakerHint = parsed.data.speakerId?.trim()
    || (isClonedSpeakerId(volcengine.speakerId) ? volcengine.speakerId : "")
    || DEFAULT_CUSTOM_SPEAKER_ID;
  const body = buildVoiceCloneBody({
    audioBase64: parsed.data.audioBase64,
    format: parsed.data.format || "wav",
    text: VOICE_CLONE_SCRIPT,
    speakerId: speakerHint
  });

  try {
    const { response, text } = await volcengineJsonRequest({
      url: VOLCENGINE_CLONE_URL,
      auth: volcengine,
      body,
      resourceId: volcengine.ttsResourceId,
      timeoutMs: 60_000
    });
    const payload = parseJson(text);
    if (!response.ok || isVoiceCloneBusinessError(payload)) {
      return NextResponse.json(
        {
          code: "VOICE_CLONE_FAILED",
          message: cloneErrorMessage(payload, response.status)
        },
        { status: 502 }
      );
    }
    const speakerId = parseVoiceCloneSpeakerId(payload);
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

/** 阿里云分支：上传 COS 换短时签名 URL → CosyVoiceClone 自动分配唯一音色 → 立即删除样本 → 绑定账号。 */
async function cloneWithAliyun(speech: Awaited<ReturnType<typeof getSpeechRuntimeConfig>>, audioBytes: Buffer) {
  const wav = truncateWavToSeconds(new Uint8Array(audioBytes), COSYVOICE_MAX_CLONE_SECONDS);
  const uploaded = await uploadVoiceSample(wav);
  if (!uploaded.ok) {
    console.warn("voice sample upload failed", {
      status: uploaded.failure.status,
      code: uploaded.failure.code
    });
    return NextResponse.json(
      { code: uploaded.failure.code, message: voiceSampleUploadFailureMessage(uploaded.failure) },
      { status: uploaded.failure.status > 0 ? uploaded.failure.status : 502 }
    );
  }
  const sample = uploaded.data;
  if (!sample) {
    return NextResponse.json(
      { code: "INVALID_RESPONSE", message: "声音刻录服务返回了无效响应，请联系管理员" },
      { status: 502 }
    );
  }
  try {
    const voiceName = await cloneCosyVoice(
      { accessKeyId: speech.accessKeyId, accessKeySecret: speech.accessKeySecret },
      { url: sample.url, voicePrefix: COSYVOICE_VOICE_PREFIX }
    );
    return bindSpeakerId(voiceName, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return NextResponse.json(
      {
        code: "VOICE_CLONE_FAILED",
        message: message && !message.startsWith("ALIYUN_COSYVOICE_")
          ? "声音刻录失败，请换安静环境后按稿再录一次"
          : "声音刻录失败，请检查阿里云语音配置和网络"
      },
      { status: 502 }
    );
  } finally {
    void deleteVoiceSample(sample.id);
  }
}

async function uploadVoiceSample(wav: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "voice-sample.wav");
  return fetchDesktopControlResult<{ id: string; url: string }>("/api/v1/client/voice-samples", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
}

async function deleteVoiceSample(id: string) {
  const result = await fetchDesktopControlResult(`/api/v1/client/voice-samples/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(5_000)
  });
  if (!result.ok) {
    console.warn("voice sample cleanup failed", {
      status: result.failure.status,
      code: result.failure.code
    });
  }
}

async function bindSpeakerId(speakerId: string, cloned: boolean) {
  try {
    await saveSpeechSpeakerId(speakerId);
    return NextResponse.json({
      speakerId,
      cloned,
      bound: true,
      enabled: true
    });
  } catch (error) {
    if (error instanceof SpeechAccountBindError) {
      return NextResponse.json(
        {
          code: error.code,
          message: error.message,
          speakerId,
          cloned,
          bound: false,
          enabled: false
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
        bound: false,
        enabled: false
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
