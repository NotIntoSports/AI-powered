import { NextResponse } from "next/server";
import { z } from "zod";
import { cloneCosyVoice, COSYVOICE_MAX_CLONE_SECONDS, COSYVOICE_VOICE_PREFIX, isCosyVoiceSpeakerId } from "../../../lib/aliyun-cosyvoice";
import { MAX_CLONE_AUDIO_BYTES, truncateWavToSeconds } from "../../../lib/pcm-wav";
import { fetchDesktopControlJson, fetchDesktopControlResult } from "../../../lib/runtime-config";
import { voiceSampleUploadFailureMessage } from "../../../lib/voice-sample-errors";
import {
	completeSpeechVoiceAllocation,
  getSpeechRuntimeConfig,
	getSpeechVoiceAllocationStatus,
  getTtsRuntimeConfig,
  getVolcengineSpeechConfig,
  isClonedSpeakerId,
	releaseSpeechVoiceAllocation,
	reserveSpeechVoiceAllocation,
	SpeechVoiceAllocationError
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
	const voiceAllocationStatus = await getSpeechVoiceAllocationStatus();
  return NextResponse.json({
    available: Boolean(volcengine?.available) || aliyunCloneReady,
    aliyunCloneReady,
    ttsAvailable: tts.ttsAvailable,
    asrAvailable: speech.asrAvailable,
    cloned: Boolean(speakerId),
    enabled: Boolean(speakerId && (tts.provider === "volcengine" || isCosyVoiceSpeakerId(speakerId))),
    source: tts.source,
    provider: tts.provider,
		voiceAllocationStatus
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
    const reservation = await reserveAllocation();
		if (reservation instanceof NextResponse) return reservation;
		return bindSpeakerId(reservation, speakerId, false);
  }

  const audioBytes = Buffer.from(parsed.data.audioBase64, "base64");
  if (!audioBytes.length || audioBytes.length > MAX_CLONE_AUDIO_BYTES) {
    return NextResponse.json(
      { code: "INVALID_AUDIO_SIZE", message: "录音不能为空且不能超过 10MB" },
      { status: 413 }
    );
  }

	const reservation = await reserveAllocation();
	if (reservation instanceof NextResponse) return reservation;

  if (!volcengine?.available) {
    return cloneWithAliyun(speech, audioBytes, reservation);
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
			await releaseAllocation(reservation);
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
		return bindSpeakerId(reservation, speakerId, true);
  } catch {
    return NextResponse.json(
      { code: "VOICE_CLONE_FAILED", message: "声音刻录失败，请检查网络和语音配置" },
      { status: 502 }
    );
  }
}

/** 阿里云分支：上传 COS 换短时签名 URL → CosyVoiceClone 自动分配唯一音色 → 立即删除样本 → 绑定账号。 */
async function cloneWithAliyun(speech: Awaited<ReturnType<typeof getSpeechRuntimeConfig>>, audioBytes: Buffer, reservation: string) {
  const wav = truncateWavToSeconds(new Uint8Array(audioBytes), COSYVOICE_MAX_CLONE_SECONDS);
  const uploaded = await uploadVoiceSample(wav);
  if (!uploaded.ok) {
		await releaseAllocation(reservation);
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
		await releaseAllocation(reservation);
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
    return bindSpeakerId(reservation, voiceName, true);
  } catch (error) {
		if (!isAmbiguousAllocationFailure(error)) await releaseAllocation(reservation);
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

async function reserveAllocation(): Promise<string | NextResponse> {
	try {
		return await reserveSpeechVoiceAllocation();
	} catch (error) {
		if (error instanceof SpeechVoiceAllocationError) {
			const already = error.code === "VOICE_ALREADY_ALLOCATED";
			const inProgress = error.code === "VOICE_ALLOCATION_IN_PROGRESS";
			return NextResponse.json({
				code: error.code,
				message: already ? "音色已分配，每个账号仅可分配一次" : inProgress ? "音色正在分配，请勿重复提交" : "无法锁定音色分配资格，请确认已登录"
			}, { status: already || inProgress ? 409 : 502 });
		}
		return NextResponse.json({ code: "VOICE_ALLOCATION_FAILED", message: "无法锁定音色分配资格，请稍后重试" }, { status: 502 });
	}
}

async function releaseAllocation(token: string) {
	try { await releaseSpeechVoiceAllocation(token); } catch { /* 保守保留服务端状态，禁止重复分配。 */ }
}

function isAmbiguousAllocationFailure(error: unknown) {
	return error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

async function bindSpeakerId(allocationToken: string, speakerId: string, cloned: boolean) {
  try {
    await completeSpeechVoiceAllocation(allocationToken, speakerId);
    return NextResponse.json({
      cloned,
      bound: true,
      enabled: true
    });
  } catch (error) {
    if (error instanceof SpeechVoiceAllocationError) {
      return NextResponse.json(
        {
          code: error.code,
          message: error.message,
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
