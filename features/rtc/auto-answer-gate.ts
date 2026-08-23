import { canAutoSubmitTranscription } from "../audio/transcription-turn.ts";

export type AutoAnswerBlockInput = {
  enabled: boolean;
  processing: boolean;
  aiSpeaking: boolean;
  outsideEchoWindow: boolean;
  meaningful: boolean;
  sessionStatus: "idle" | "running" | "finished";
  currentRevision: number;
  lastTranscriptRole?: "interviewer" | "candidate";
};

export function getAutoAnswerBlockReason(input: AutoAnswerBlockInput): string {
  if (!input.enabled) return "automatic-mode-paused";
  if (input.aiSpeaking || !input.outsideEchoWindow) return "tts-echo-window";
  if (input.processing) return "previous-turn-processing";
  if (!input.meaningful) return "subtitle-not-meaningful";
  if (input.sessionStatus !== "running") return "session-not-running";
  return canAutoSubmitTranscription({
    sessionStatus: input.sessionStatus,
    currentRevision: input.currentRevision,
    capturedRevision: input.currentRevision,
    lastTranscriptRole: input.lastTranscriptRole
  }) ? "" : "turn-not-ready";
}

export function getAutoAnswerBlockedMessage(reason: string): string | null {
  if (reason === "automatic-mode-paused" || reason === "tts-echo-window" || reason === "subtitle-not-meaningful") {
    return null;
  }
  if (reason === "previous-turn-processing" || reason === "turn-not-ready") {
    return "AI 正在处理上一轮，这句字幕未自动提交";
  }
  if (reason === "session-not-running") {
    return "互动尚未开始，这句字幕未进入对话记录";
  }
  return null;
}
