import { NextResponse } from "next/server";
import { MAX_AUDIO_BYTES, transcribeAudio } from "../../../lib/transcription";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const startedAt = Date.now();
  let audioBytes = 0;
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      console.warn("[transcribe] missing audio field");
      return NextResponse.json(
        { code: "MISSING_AUDIO", message: "没有收到音频片段" },
        { status: 422 }
      );
    }
    audioBytes = audio.size;
    const text = await transcribeAudio(audio);
    console.log(
      `[transcribe] ok bytes=${audioBytes} textLen=${text.length} elapsedMs=${Date.now() - startedAt}`
    );
    return NextResponse.json({ text });
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    console.warn(
      `[transcribe] failed code=${code} bytes=${audioBytes} elapsedMs=${Date.now() - startedAt}`
    );
    if (code === "INVALID_AUDIO_SIZE") {
      return NextResponse.json(
        { code, message: `音频不能为空且不能超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB` },
        { status: 413 }
      );
    }
    if (code === "UNSUPPORTED_AUDIO") {
      return NextResponse.json(
        { code, message: "音频格式或文件内容不受支持" },
        { status: 415 }
      );
    }
    if (code === "MISSING_TRANSCRIPTION_KEY") {
      return NextResponse.json(
        {
          code,
          message: "请配置该转写服务自己的 API Key；只有转写地址与模型地址一致时才会复用模型密钥"
        },
        { status: 503 }
      );
    }
    if (code === "INSECURE_TRANSCRIPTION_ENDPOINT") {
      return NextResponse.json(
        {
          code,
          message: "远程转写地址必须使用 HTTPS；只有本机回环地址允许 HTTP"
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { code: "TRANSCRIPTION_FAILED", message: "语音转写失败，请检查转写服务" },
      { status: 502 }
    );
  }
}
