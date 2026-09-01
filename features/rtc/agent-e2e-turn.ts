"use client";

import { useEffect, useRef } from "react";
import { agentResponseSink } from "../../lib/agent-response/sink";
import { emitPipelineEvent } from "../diagnostics/pipeline-log.ts";
import { AgentE2eQueue } from "./agent-e2e-queue.ts";

export type AgentE2eTurnOptions = {
  enabled: boolean;
  processing?: boolean;
  aiSpeaking: boolean;
  getExpectedRevision: () => number;
  onTurn(input: { answer: string; question: string; expectedRevision: number }): boolean | Promise<boolean>;
  onBlocked?(message: string): void;
};

export function useAgentE2eTurn({
  enabled,
  processing = false,
  aiSpeaking,
  getExpectedRevision,
  onTurn,
  onBlocked
}: AgentE2eTurnOptions) {
  const stateRef = useRef({ enabled, processing, aiSpeaking, getExpectedRevision, onTurn, onBlocked });
  stateRef.current = { enabled, processing, aiSpeaking, getExpectedRevision, onTurn, onBlocked };
  const queueRef = useRef(new AgentE2eQueue());
  const submittingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const drain = async () => {
    const state = stateRef.current;
    if (!state.enabled || state.processing || state.aiSpeaking || submittingRef.current) return;
    const line = queueRef.current.peek();
    if (!line) return;
    submittingRef.current = true;
    try {
      const ok = await state.onTurn({
        answer: line.candidateText,
        question: line.replyText,
        expectedRevision: state.getExpectedRevision()
      });
      if (ok) queueRef.current.shift();
      else state.onBlocked?.("Agent 结果提交失败，已保留；恢复后将继续提交。");
    } finally {
      submittingRef.current = false;
      if (queueRef.current.size && stateRef.current.enabled && queueRef.current.peek() !== line) {
        retryTimerRef.current = setTimeout(() => void drain(), 250);
      }
    }
  };

  useEffect(() => {
    if (!enabled) {
      queueRef.current.clear();
      return;
    }
    return agentResponseSink.subscribeFinal((line) => {
      const state = stateRef.current;
      if (!state.enabled || !queueRef.current.enqueue(line)) return;
      void emitPipelineEvent({
        event: "agent-response.final-received",
        traceId: line.sessionId,
        fields: {
          utteranceId: line.utteranceId,
          candidateLength: line.candidateText.length,
          replyLength: line.replyText.length,
          source: line.source || "livekit-e2e"
        }
      });
      void drain();
    });
  }, [enabled]);

  useEffect(() => {
    void drain();
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [enabled, processing, aiSpeaking]);
}
