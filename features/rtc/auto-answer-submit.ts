"use client";

import { useEffect, useRef } from "react";
import { subtitleSink } from "../../lib/subtitles/sink";
import { canAutoSubmitTranscription } from "../audio/transcription-turn";

/** AI 播报结束后仍丢弃该窗口内的 final 字幕，防止会议回传的 AI 声音被当作对方回答。 */
const ECHO_TAIL_MS = 1_500;

export type AutoAnswerGate = {
  sessionStatus: "idle" | "running" | "finished";
  currentRevision: number;
  lastTranscriptRole?: "interviewer" | "candidate";
};

/** 过滤空白与纯标点/符号的转写行，避免无意义提交。 */
export function isMeaningfulSubtitle(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length > 0;
}

export type AutoAnswerSubmitOptions = {
  enabled: boolean;
  aiSpeaking: boolean;
  getGate: () => AutoAnswerGate;
  onAnswer(text: string): void;
};

/** 订阅实时字幕的 final 行，满足条件时自动作为对方回答提交。 */
export function useAutoAnswerSubmit({ enabled, aiSpeaking, getGate, onAnswer }: AutoAnswerSubmitOptions) {
  const stateRef = useRef({ enabled, aiSpeaking, getGate, onAnswer });
  stateRef.current = { enabled, aiSpeaking, getGate, onAnswer };
  const tailUntilRef = useRef(0);

  useEffect(() => {
    if (aiSpeaking) tailUntilRef.current = Date.now() + ECHO_TAIL_MS;
  }, [aiSpeaking]);

  useEffect(
    () =>
      subtitleSink.subscribeFinal((line) => {
        const state = stateRef.current;
        if (!state.enabled) return;
        if (Date.now() < tailUntilRef.current) return;
        const text = String(line.text || "").trim();
        if (!isMeaningfulSubtitle(text)) return;
        const gate = state.getGate();
        const allowed = canAutoSubmitTranscription({
          sessionStatus: gate.sessionStatus,
          currentRevision: gate.currentRevision,
          capturedRevision: gate.currentRevision,
          lastTranscriptRole: gate.lastTranscriptRole
        });
        if (!allowed) return;
        state.onAnswer(text);
      }),
    []
  );
}
