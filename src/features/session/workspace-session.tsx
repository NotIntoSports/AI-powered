import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../api/commands";
import type {
  CommandResult,
  RuntimeStatus,
  SessionReplyEvent,
  SessionTranscriptEvent,
} from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

const ACTIVE_PHASES = new Set([
  "preparing",
  "listening",
  "thinking",
  "speaking",
  "stopping",
  "recovering",
  "blocked",
]);

export type SessionListen = <T>(
  event: string,
  handler: (payload: T) => void,
) => Promise<() => void> | (() => void);

export interface WorkspaceSessionProps {
  finalizeUtterance?: (text: string) => Promise<void>;
  listen?: SessionListen;
}

async function defaultFinalizeUtterance(text: string) {
  const result = await api.finalizeSessionUtterance(text);
  if (!result.ok) {
    throw new Error(errorText(result.error));
  }
}

async function defaultListen<T>(event: string, handler: (payload: T) => void) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  try {
    const mod = await import("@tauri-apps/api/event");
    return mod.listen<T>(event, (envelope) => handler(envelope.payload));
  } catch {
    return () => {};
  }
}

export function WorkspaceSession({
  finalizeUtterance = defaultFinalizeUtterance,
  listen = defaultListen,
}: WorkspaceSessionProps) {
  const [phase, setPhase] = useState("idle");
  const [mode, setMode] = useState("ai_active");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [unusedMaterials, setUnusedMaterials] = useState(false);
  const [message, setMessage] = useState("正在读取会话状态…");
  const [busy, setBusy] = useState(false);
  const [utterance, setUtterance] = useState("");
  const statusSeq = useRef(0);
  const transcriptSeq = useRef(0);
  const replySeq = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const applyStatus = useCallback((next: RuntimeStatus) => {
    if (next.seq <= statusSeq.current) return;
    statusSeq.current = next.seq;
    setPhase(next.phase);
    setMode(next.mode);
    setUnusedMaterials(next.unusedMaterials);
    if (next.lastErrorCode) {
      setMessage(`runtime：${next.lastErrorCode}：会话运行时错误`);
    }
  }, []);

  const applyTranscript = useCallback((payload: SessionTranscriptEvent) => {
    if (payload.seq <= transcriptSeq.current) return;
    transcriptSeq.current = payload.seq;
    setTranscript(payload.text);
  }, []);

  const applyReply = useCallback((payload: SessionReplyEvent) => {
    if (payload.seq <= replySeq.current) return;
    replySeq.current = payload.seq;
    setReply(payload.text);
  }, []);

  const refresh = useCallback(
    async (id?: string | null) => {
      const target = id ?? sessionIdRef.current;
      try {
        const statusResult = await api.getRuntimeStatus();
        if (statusResult.ok) {
          applyStatus(statusResult.data);
        } else {
          setMessage(errorText(statusResult.error));
        }
        if (target) {
          const detail = await api.getSession(target);
          if (detail.ok) {
            const last = detail.data.turns.at(-1);
            if (last) {
              setTranscript(last.userText);
              setReply(last.assistantText);
              setUnusedMaterials(!last.materialsUsed);
            }
          } else {
            setMessage(errorText(detail.error));
          }
        }
      } catch {
        setMessage("IPC_UNAVAILABLE：无法读取会话状态");
      }
    },
    [applyStatus],
  );

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.getRuntimeStatus();
        if (result.ok) {
          applyStatus(result.data);
          setMessage("");
        } else {
          setMessage(errorText(result.error));
        }
      } catch {
        setMessage("IPC_UNAVAILABLE：无法读取会话状态");
      }
    })();
  }, [applyStatus]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const topics: Array<[string, (payload: never) => void]> = [
        ["runtime.status.v1", applyStatus as (payload: never) => void],
        ["session.transcript.v1", applyTranscript as (payload: never) => void],
        ["session.reply.v1", applyReply as (payload: never) => void],
      ];
      for (const [event, handler] of topics) {
        try {
          const unlisten = await Promise.resolve(listen(event, handler));
          if (cancelled) {
            unlisten();
            return;
          }
          unlisteners.push(unlisten);
        } catch {
          // Event bus is optional when IPC is unavailable.
        }
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [listen, applyStatus, applyTranscript, applyReply]);

  async function run(action: () => Promise<CommandResult<unknown>>, success = "") {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        setMessage(errorText(result.error));
        return false;
      }
      if (success) setMessage(success);
      else setMessage("");
      return true;
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    try {
      const result = await api.startSession();
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      if (result.data.kind === "blocked") {
        setMessage(
          result.data.issues.map((issue) => `${issue.area}：${issue.code}：${issue.action}`).join("；"),
        );
        return;
      }
      setSessionId(result.data.session.id);
      sessionIdRef.current = result.data.session.id;
      setPhase(result.data.session.status);
      setTranscript("");
      setReply("");
      setUnusedMaterials(false);
      setUtterance("");
      setMessage("");
      await refresh(result.data.session.id);
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    const ok = await run(() => api.stopSession());
    if (ok) {
      await refresh();
    }
  }

  async function setModeName(next: "ai_active" | "operator_speaking" | "paused" | "muted") {
    const ok = await run(() => api.setSessionMode(next));
    if (ok) {
      setMode(next);
      await refresh();
    }
  }

  async function submitFinalize(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await finalizeUtterance(utterance.trim());
      setMessage("");
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      setMessage(text.includes("：") ? text : "IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  const active = ACTIVE_PHASES.has(phase);

  return (
    <section className="service-panel workspace-session" aria-labelledby="workspace-session-heading">
      <h2 id="workspace-session-heading">当前会话</h2>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      <p>阶段 {phase}</p>
      <p>模式 {mode}</p>
      <div className="service-actions">
        <button disabled={busy || active} type="button" onClick={() => void start()}>
          开始
        </button>
        <button disabled={!active} type="button" onClick={() => void stop()}>
          停止
        </button>
        <button disabled={!active} type="button" onClick={() => void setModeName("operator_speaking")}>
          接管
        </button>
        <button disabled={busy || !active} type="button" onClick={() => void setModeName("ai_active")}>
          恢复 AI
        </button>
        <button disabled={busy || !active} type="button" onClick={() => void setModeName("muted")}>
          静音
        </button>
      </div>
      {transcript && <p>转写 {transcript}</p>}
      {reply && <p>回复 {reply}</p>}
      {unusedMaterials && <p>本轮未使用资料</p>}
      <form className="service-form" onSubmit={submitFinalize}>
        <label>
          测试语句
          <input value={utterance} onChange={(event) => setUtterance(event.target.value)} />
        </label>
        <button disabled={busy} type="submit">
          提交语句
        </button>
      </form>
    </section>
  );
}
