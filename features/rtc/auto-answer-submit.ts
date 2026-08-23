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
  processing?: boolean;
  aiSpeaking: boolean;
  getGate: () => AutoAnswerGate;
  onAnswer(text: string): void;
  onBlocked?(message: string): void;
};

export function isOutsideEchoWindow(input: { aiSpeaking: boolean; now: number; tailUntil: number }): boolean {
  return !input.aiSpeaking && input.now >= input.tailUntil;
}

/** 订阅实时字幕的 final 行，满足条件时自动作为对方回答提交。 */
export function useAutoAnswerSubmit({ enabled, processing = false, aiSpeaking, getGate, onAnswer, onBlocked }: AutoAnswerSubmitOptions) {
  const stateRef = useRef({ enabled, processing, aiSpeaking, getGate, onAnswer, onBlocked });
  stateRef.current = { enabled, processing, aiSpeaking, getGate, onAnswer, onBlocked };
  const tailUntilRef = useRef(0);
  const wasSpeakingRef = useRef(false);

  useEffect(() => {
    if (wasSpeakingRef.current && !aiSpeaking) tailUntilRef.current = Date.now() + ECHO_TAIL_MS;
    wasSpeakingRef.current = aiSpeaking;
  }, [aiSpeaking]);

  useEffect(
    () =>
      subtitleSink.subscribeFinal((line) => {
        const state = stateRef.current;
        if (!state.enabled) {
          state.onBlocked?.("AI 自动模式已暂停，这句字幕未提交");
          return;
        }
        if (!isOutsideEchoWindow({ aiSpeaking: state.aiSpeaking, now: Date.now(), tailUntil: tailUntilRef.current })) return;
        if (state.processing) {
          state.onBlocked?.("AI 正在处理上一轮，这句字幕未自动提交");
          return;
        }
        const text = String(line.text || "").trim();
        if (!isMeaningfulSubtitle(text)) return;
        const gate = state.getGate();
        const allowed = canAutoSubmitTranscription({
          sessionStatus: gate.sessionStatus,
          currentRevision: gate.currentRevision,
          capturedRevision: gate.currentRevision,
          lastTranscriptRole: gate.lastTranscriptRole
        });
        if (!allowed) {
          state.onBlocked?.(gate.sessionStatus !== "running"
            ? "互动尚未开始，这句字幕未进入对话记录"
            : "AI 正在处理上一轮，这句字幕未自动提交");
          return;
        }
        state.onAnswer(text);
      }),
    []
  );
}
