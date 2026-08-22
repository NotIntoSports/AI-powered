import { createHmac, randomUUID } from "node:crypto";
import {
  aliyunGateway,
  canonicalQuery,
  iso8601Utc,
  percentEncode,
  resolveAliyunNlsToken,
  type AliyunNlsAuth
} from "./aliyun-nls";

export const ALIYUN_COSYVOICE_POP_URL = "https://nls-slp.cn-shanghai.aliyuncs.com/";
export const ALIYUN_COSYVOICE_API_VERSION = "2019-08-19";
export const COSYVOICE_VOICE_PREFIX = "vh";
export const COSYVOICE_SAMPLE_RATE = 24_000;
export const COSYVOICE_MAX_CLONE_SECONDS = 20;
export const COSYVOICE_NAMESPACE = "FlowingSpeechSynthesizer";
const COSYVOICE_SUCCESS_STATUS = 20_000_000;

export type CosyVoiceCloneAuth = {
  accessKeyId: string;
  accessKeySecret: string;
};

export type CosyVoiceRecord = {
  voiceName: string;
  status: string;
  gmtCreate: string;
};

export type CosyVoiceListResult = {
  voices: CosyVoiceRecord[];
  totalCount: number;
  pageIndex: number;
  pageSize: number;
};

export function isCosyVoiceSpeakerId(speakerId: string) {
  return speakerId.trim().toLowerCase().startsWith("cosyvoice-");
}

function messageId() {
  return randomUUID().replace(/-/g, "");
}

/** 通用阿里云 POP（RPC 风格）签名请求，与 CreateToken 同机制：HMAC-SHA1 + ISO8601 UTC + SignatureNonce。 */
export function buildPopRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  action: string;
  version: string;
  endpoint: string;
  method?: "GET" | "POST";
  params?: Record<string, string>;
  timestamp?: string;
  nonce?: string;
}) {
  const method = input.method || "POST";
  const params: Record<string, string> = {
    AccessKeyId: input.accessKeyId,
    Action: input.action,
    Format: "JSON",
    RegionId: "cn-shanghai",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: input.nonce || randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: input.timestamp || iso8601Utc(),
    Version: input.version,
    ...(input.params || {})
  };
  const query = canonicalQuery(params);
  const stringToSign = `${method}&${percentEncode("/")}&${percentEncode(query)}`;
  const signature = createHmac("sha1", `${input.accessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
  const endpoint = input.endpoint.replace(/\/$/, "");
  // 官方示例形态：全部参数（含签名）放 URL query，POST 空 body。
  const url = `${endpoint}/?${query}&Signature=${percentEncode(signature)}`;
  return {
    method,
    url,
    body: undefined,
    query,
    signature,
    stringToSign
  };
}

async function popJsonRequest(input: {
  auth: CosyVoiceCloneAuth;
  action: string;
  params?: Record<string, string>;
  timeoutMs?: number;
}) {
  const request = buildPopRequest({
    accessKeyId: input.auth.accessKeyId.trim(),
    accessKeySecret: input.auth.accessKeySecret.trim(),
    action: input.action,
    version: ALIYUN_COSYVOICE_API_VERSION,
    endpoint: ALIYUN_COSYVOICE_POP_URL,
    method: "POST",
    params: input.params
  });
  const response = await fetch(request.url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
  });
  const payload = await response.json().catch(() => null) as {
    Code?: string | number;
    Message?: string;
    [key: string]: unknown;
  } | null;
  const code = payload?.Code;
  const failed = !response.ok || (code !== undefined && code !== 20_000_000 && code !== "20000000");
  if (failed) {
    const codeText = code === undefined ? "" : String(code);
    const message = typeof payload?.Message === "string" ? payload.Message : "";
    throw new Error(message || codeText || `ALIYUN_COSYVOICE_${response.status}`);
  }
  return payload || {};
}

/** 声音复刻：平台按前缀自动生成唯一 VoiceName（cosyvoice-<prefix>-xxxxxxx），无需挑选空闲 ID。 */
export async function cloneCosyVoice(auth: CosyVoiceCloneAuth, input: {
  url: string;
  voicePrefix?: string;
  timeoutMs?: number;
}) {
  const payload = await popJsonRequest({
    auth,
    action: "CosyVoiceClone",
    params: {
      Url: input.url,
      VoicePrefix: (input.voicePrefix || COSYVOICE_VOICE_PREFIX).trim() || COSYVOICE_VOICE_PREFIX
    },
    timeoutMs: input.timeoutMs ?? 60_000
  });
  const voiceName = typeof payload.VoiceName === "string" ? payload.VoiceName.trim() : "";
  if (!voiceName) throw new Error("COSYVOICE_CLONE_NO_VOICE");
  return voiceName;
}

/** 查询指定前缀下已复刻音色列表（阿里云要求必传 VoicePrefix），供管理端审计。 */
export async function listCosyVoice(auth: CosyVoiceCloneAuth, input: {
  voicePrefix?: string;
  pageIndex?: number;
  pageSize?: number;
  timeoutMs?: number;
} = {}): Promise<CosyVoiceListResult> {
  const payload = await popJsonRequest({
    auth,
    action: "ListCosyVoice",
    params: {
      VoicePrefix: (input.voicePrefix || COSYVOICE_VOICE_PREFIX).trim() || COSYVOICE_VOICE_PREFIX,
      PageIndex: String(Math.max(1, input.pageIndex ?? 1)),
      PageSize: String(input.pageSize ?? 20)
    },
    timeoutMs: input.timeoutMs ?? 15_000
  });
  const rawList = Array.isArray(payload.VoiceList) ? payload.VoiceList : Array.isArray(payload.Voices) ? payload.Voices : [];
  const voices = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      voiceName: typeof item.VoiceName === "string" ? item.VoiceName : "",
      status: typeof item.Status === "string" ? item.Status : typeof item.Status === "number" ? String(item.Status) : "",
      gmtCreate: typeof item.GmtCreate === "string" ? item.GmtCreate : ""
    }))
    .filter((item) => item.voiceName);
  const totalCount = Number(payload.TotalCount);
  return {
    voices,
    totalCount: Number.isFinite(totalCount) ? totalCount : voices.length,
    pageIndex: input.pageIndex ?? 1,
    pageSize: input.pageSize ?? 20
  };
}

/**
 * CosyVoice 大模型长文本语音合成（FlowingSpeechSynthesizer WebSocket 协议）。
 * 复刻音色只能走该线路；wav 格式分帧下发、首帧含文件头，拼接全部二进制帧即完整 WAV。
 */
export async function synthesizeCosyVoiceSpeech(
  auth: AliyunNlsAuth,
  text: string,
  timeoutMs = 60_000
): Promise<Uint8Array> {
  const token = await resolveAliyunNlsToken(auth);
  const gateway = aliyunGateway(auth).replace(/^https?:/, "wss:");
  const taskId = messageId();
  const frames: Uint8Array[] = [];
  let started = false;
  let completed = false;
  let failed = "";

  const socket = new WebSocket(`${gateway}/ws/v1?token=${encodeURIComponent(token.id)}`);
  socket.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(failed || "COSYVOICE_TTS_TIMEOUT")),
        timeoutMs
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          header: {
            message_id: messageId(),
            task_id: taskId,
            namespace: COSYVOICE_NAMESPACE,
            name: "StartSynthesis",
            appkey: auth.appKey.trim()
          },
          payload: {
            voice: (auth.voice || "").trim() || "longxiaochun",
            format: "wav",
            sample_rate: COSYVOICE_SAMPLE_RATE,
            volume: 50,
            speech_rate: 0,
            pitch_rate: 0
          }
        }));
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") {
          const payload = JSON.parse(event.data) as {
            header?: { name?: string; status?: number; status_message?: string; status_text?: string };
          };
          const header = payload.header || {};
          const detail = header.status_message || header.status_text || "";
          if (header.name === "SynthesisStarted") {
            if (header.status !== COSYVOICE_SUCCESS_STATUS) {
              failed = detail || cosyVoiceFailureMessage(header.status);
              finish(new Error(failed));
              return;
            }
            started = true;
            socket.send(JSON.stringify({
              header: {
                message_id: messageId(),
                task_id: taskId,
                namespace: COSYVOICE_NAMESPACE,
                name: "RunSynthesis",
                appkey: auth.appKey.trim()
              },
              payload: { text }
            }));
            socket.send(JSON.stringify({
              header: {
                message_id: messageId(),
                task_id: taskId,
                namespace: COSYVOICE_NAMESPACE,
                name: "StopSynthesis",
                appkey: auth.appKey.trim()
              }
            }));
            return;
          }
          if (header.name === "SynthesisCompleted") {
            completed = true;
            finish();
            return;
          }
          if (header.name === "TaskFailed" || (typeof header.status === "number" && header.status !== COSYVOICE_SUCCESS_STATUS)) {
            failed = detail || cosyVoiceFailureMessage(header.status);
            finish(new Error(failed));
          }
          return;
        }
        if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
          frames.push(new Uint8Array(event.data.slice(0)));
        }
      });
      socket.addEventListener("error", () => {
        if (!completed) finish(new Error(failed || "COSYVOICE_TTS_SOCKET_ERROR"));
      });
      socket.addEventListener("close", () => {
        if (!completed && !started) finish(new Error(failed || "COSYVOICE_TTS_CLOSED"));
        else if (!completed) finish(new Error(failed || "COSYVOICE_TTS_CLOSED_EARLY"));
      });
    });
  } finally {
    try {
      socket.close();
    } catch {
      // 关闭失败不影响合成结果。
    }
  }
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  if (!completed || total === 0) throw new Error(failed || "COSYVOICE_TTS_EMPTY");
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame, offset);
    offset += frame.byteLength;
  }
  return merged;
}

/** 常见网关状态码的友好提示（其余直接透传状态码）。 */
export function cosyVoiceFailureMessage(status?: number) {
  if (status === 40_000_010) {
    return "阿里云 CosyVoice 商用版未开通（或试用期已结束/账号欠费），请在控制台开通后重试";
  }
  if (status === 40_000_001) {
    return "音色不存在或无权限，请确认复刻音色已生成";
  }
  return `COSYVOICE_TTS_${status || "FAILED"}`;
}
