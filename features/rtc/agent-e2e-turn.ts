"use client";

import { useEffect, useRef } from "react";
import { agentResponseSink } from "../../lib/agent-response/sink";
import { emitPipelineEvent } from "../diagnostics/pipeline-log.ts";

export type AgentE2eTurnOptions = {
  enabled: boolean;
  processing?: boolean;
  aiSpeaking: boolean;
  getExpectedRevision: () => number;
  onTurn(input: { answer: string; question: string; expectedRevision: number }): void | Promise<void>;
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
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      handledRef.current.clear();
      return;
    }
    return agentResponseSink.subscribeFinal((line) => {
      const state = stateRef.current;
      if (!state.enabled || state.processing || state.aiSpeaking) {
        state.onBlocked?.("端到端回复尚未提交：当前仍在处理或 AI 正在播报。");
        return;
      }
      const key = `${line.sessionId}:${line.utteranceId}`;
      if (handledRef.current.has(key)) return;
      handledRef.current.add(key);
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
      void state.onTurn({
        answer: line.candidateText,
        question: line.replyText,
        expectedRevision: state.getExpectedRevision()
      });
    });
  }, [enabled]);
}
