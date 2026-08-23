"use client";

import { useEffect, useRef } from "react";
import { emitPipelineEvent } from "../diagnostics/pipeline-log.ts";
import { subtitleSink } from "../../lib/subtitles/sink";
import { getAutoAnswerBlockedMessage, getAutoAnswerBlockReason } from "./auto-answer-gate.ts";

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
        const text = String(line.text || "").trim();
        const gate = state.getGate();
        const reason = getAutoAnswerBlockReason({
          enabled: state.enabled,
          processing: state.processing,
          aiSpeaking: state.aiSpeaking,
          outsideEchoWindow: isOutsideEchoWindow({
            aiSpeaking: state.aiSpeaking,
            now: Date.now(),
            tailUntil: tailUntilRef.current
          }),
          meaningful: isMeaningfulSubtitle(text),
          sessionStatus: gate.sessionStatus,
          currentRevision: gate.currentRevision,
          lastTranscriptRole: gate.lastTranscriptRole
        });
        void emitPipelineEvent({
          event: "subtitle.final-received",
          traceId: line.sessionId,
          fields: {
            final: true,
            textLength: text.length,
            source: line.source || "unknown",
            utteranceId: line.utteranceId
          }
        });
        if (reason) {
          void emitPipelineEvent({
            event: "auto-answer.blocked",
            traceId: line.sessionId,
            fields: {
              reason,
              sessionStatus: gate.sessionStatus,
              revision: gate.currentRevision,
              ttsState: state.aiSpeaking ? "speaking" : "idle"
            }
          });
        }
        const blockedMessage = getAutoAnswerBlockedMessage(reason);
        if (blockedMessage) state.onBlocked?.(blockedMessage);
        if (reason) return;
        void emitPipelineEvent({
          event: "auto-answer.submitted",
          traceId: line.sessionId,
          fields: { revision: gate.currentRevision, textLength: text.length }
        });
        state.onAnswer(text);
      }),
    []
  );
}
