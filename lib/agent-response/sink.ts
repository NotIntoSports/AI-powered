import {
  parseAgentResponseInput,
  type AgentResponseInput,
  type AgentResponseLine
} from "./contract.ts";

export type AgentResponseListener = (lines: AgentResponseLine[]) => void;
export type FinalAgentResponseListener = (line: AgentResponseLine) => void;

export type AgentResponseSink = {
  publish(input: AgentResponseInput | unknown): void;
  subscribe(listener: AgentResponseListener): () => void;
  subscribeFinal(listener: FinalAgentResponseListener): () => void;
  reset(sessionId?: string): void;
  snapshot(): AgentResponseLine[];
};

const maxLines = 100;

export function createAgentResponseSink(defaultLanguage = "zh"): AgentResponseSink {
  let lines: AgentResponseLine[] = [];
  const listeners = new Set<AgentResponseListener>();
  const finalListeners = new Set<FinalAgentResponseListener>();

  function notify() {
    const snapshot = lines.slice();
    for (const listener of listeners) listener(snapshot);
  }

  return {
    publish(input) {
      const parsed = parseAgentResponseInput(input);
      if (!parsed.ok) return;
      const previous = lines.find((item) =>
        item.sessionId === parsed.value.sessionId && item.utteranceId === parsed.value.utteranceId
      );
      const nextLine: AgentResponseLine = {
        sessionId: parsed.value.sessionId,
        utteranceId: parsed.value.utteranceId,
        candidateText: parsed.value.candidateText,
        replyText: parsed.value.replyText,
        final: parsed.value.final,
        language: parsed.value.language || defaultLanguage,
        emittedAt: parsed.value.emittedAt,
        receivedAt: Date.now(),
        source: parsed.value.source
      };
      lines = [
        ...lines.filter((item) =>
          !(item.sessionId === nextLine.sessionId && item.utteranceId === nextLine.utteranceId)
        ),
        nextLine
      ].slice(-maxLines);
      notify();
      if (nextLine.final && !previous?.final) {
        for (const listener of finalListeners) listener(nextLine);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(lines.slice());
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeFinal(listener) {
      finalListeners.add(listener);
      return () => {
        finalListeners.delete(listener);
      };
    },
    reset(sessionId) {
      lines = sessionId ? lines.filter((item) => item.sessionId !== sessionId) : [];
      notify();
    },
    snapshot() {
      return lines.slice();
    }
  };
}

export const agentResponseSink = createAgentResponseSink();
