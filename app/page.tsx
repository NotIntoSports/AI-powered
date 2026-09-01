"use client";

import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InterviewSession } from "../lib/interview";
import { assistantRoleIds, builtInRoleProfiles, transcriptSpeakerLabel, type AssistantRole } from "../lib/assistant-role";
import { InterventionControls } from "../features/intervention/intervention-controls";
import { MeetingBridgeCard } from "../features/rtc/meeting-bridge-card";
import { sendAgentCommand } from "../features/rtc/bridge-session";
import { useAgentE2eTurn } from "../features/rtc/agent-e2e-turn";
import {
  getAutoBridgeStatus,
  subscribeAutoBridgeStatus,
  type AutoBridgeStatus
} from "../features/rtc/auto-bridge-controller";
import { decideAutoSessionStart } from "../features/rtc/auto-session-start";
import { UserAccountMenu } from "../features/settings/user-account-menu";
import { selectTimelineSubtitleLines } from "../features/subtitles/timeline";
import {
  createTranscriptFollowState,
  isTranscriptNearBottom,
  reduceTranscriptFollowState,
  type TranscriptFollowEvent,
} from "../features/subtitles/scroll-follow";
import { subtitleSink } from "../lib/subtitles/sink";
import type { SubtitleLine } from "../lib/subtitles/contract";
import { getInterviewReadiness } from "../features/readiness/interview-readiness";
import { getSnapshotReadiness, invalidateDeviceReadiness, loadReadinessSnapshot } from "../features/readiness/readiness-snapshot";
import { loadOutputMode, subscribeOutputMode, type OutputMode } from "../features/readiness/output-mode";
import { AppChrome } from "../features/settings/app-chrome";
import { IntegrationAlerts } from "../features/meeting/integration-alerts";
import { setManagementNetwork } from "../features/rtc/network-quality";

type Diagnostics = {
  server: boolean;
  stageConnected: boolean;
  ttsSupported: boolean;
  voiceCount: number;
  sapiConfigured: boolean;
  sapiVoiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
};

const emptySession: InterviewSession = {
  sessionId: "",
  revision: 0,
  status: "idle",
  speakingText: "",
  candidateName: "",
  roleName: "",
  assistantRole: "interviewer",
  roleProfile: structuredClone(builtInRoleProfiles.interviewer),
  jobDescription: "",
  interviewFocus: "",
  consentConfirmed: false,
  consentConfirmedAt: null,
  startedAt: null,
  finishedAt: null,
  transcript: [],
  report: null,
  resumeIds: [],
  resumeId: ""
};

async function sessionAction(payload: object): Promise<InterviewSession> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "操作失败");
  return data;
}
export default function ConsolePage() {
  const [session, setSession] = useState(emptySession);
  const [candidateName, setCandidateName] = useState("");
  const [roleName, setRoleName] = useState("");
  const [assistantRole, setAssistantRole] = useState<AssistantRole | "">("");
  const [jobDescription, setJobDescription] = useState("");
  const [interviewFocus, setInterviewFocus] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [resumeIds, setResumeIds] = useState<string[]>([]);
  const [manualText, setManualText] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    server: false,
    stageConnected: false,
    ttsSupported: false,
    voiceCount: 0,
    sapiConfigured: false,
    sapiVoiceCount: 0,
    ttsState: "idle",
    ttsError: "",
    lastSpeechAt: 0,
    mediaReady: false
  });
  const sessionRef = useRef(emptySession);
  const [automaticFollowup, setAutomaticFollowup] = useState(true);
  const [autoBridgeStatus, setAutoBridgeStatus] = useState<AutoBridgeStatus>(getAutoBridgeStatus);
  const [autoStartPending, setAutoStartPending] = useState(false);
  const [autoStartError, setAutoStartError] = useState("");
  const [autoStartRetry, setAutoStartRetry] = useState(0);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [subtitleLines, setSubtitleLines] = useState<SubtitleLine[]>([]);
  const [answerPending, setAnswerPending] = useState(false);
  const [pendingFinalText, setPendingFinalText] = useState("");
  const [error, setError] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("real");
  const [uploadOpen, setUploadOpen] = useState(false);
  const autoStartAttemptedRef = useRef("");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const followStateRef = useRef(createTranscriptFollowState());
  const followFrameRef = useRef<number | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [snapshotReadiness, setSnapshotReadiness] = useState(() => getSnapshotReadiness({}));
  const readiness = getInterviewReadiness({
    outputMode,
    stageConnected: diagnostics.stageConnected,
    mediaReady: diagnostics.mediaReady,
    ...snapshotReadiness
  });

  useEffect(() => {
    void fetch("/api/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setError("无法读取当前互动会话"))
      .finally(() => setSessionLoaded(true));
    setSnapshotReadiness(getSnapshotReadiness(loadReadinessSnapshot()));
    setOutputMode(loadOutputMode());
    return subscribeOutputMode(() => setOutputMode(loadOutputMode()));
  }, []);

  useEffect(() => subscribeAutoBridgeStatus(() => setAutoBridgeStatus(getAutoBridgeStatus())), []);
  useEffect(() => subtitleSink.subscribe(setSubtitleLines), []);

  useEffect(() => {
    const refresh = () => setSnapshotReadiness(getSnapshotReadiness(loadReadinessSnapshot()));
    const timer = window.setInterval(refresh, 1_000);
    const mediaDevices = navigator.mediaDevices;
    const handleDeviceChange = () => { invalidateDeviceReadiness(); refresh(); };
    mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    return () => { window.clearInterval(timer); mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange); };
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!sessionLoaded) return;
    const decision = decideAutoSessionStart({
      bridgeState: autoBridgeStatus.state,
      bridgeSessionKey: autoBridgeStatus.sessionKey,
      sessionStatus: session.status,
      assistantRole,
      pending: autoStartPending,
      attemptedSessionKey: autoStartAttemptedRef.current
    });
    if (!decision.shouldStart || !autoBridgeStatus.sessionKey) return;

    const sessionKey = autoBridgeStatus.sessionKey;
    autoStartAttemptedRef.current = sessionKey;
    setAutoStartPending(true);
    setAutoStartError("");
    void sessionAction({
      action: "start",
      candidateName,
      roleName,
      assistantRole,
      jobDescription,
      interviewFocus,
      consentConfirmed,
      resumeIds: resumeIds.length ? resumeIds : undefined
    })
      .then((next) => { applySessionResult(next); setConsentConfirmed(false); })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "自动开始失败";
        setAutoStartError(`自动开始失败：${message}`);
      })
      .finally(() => setAutoStartPending(false));
  }, [
    autoBridgeStatus.sessionKey,
    autoBridgeStatus.state,
    autoStartPending,
    autoStartRetry,
    candidateName,
    consentConfirmed,
    interviewFocus,
    jobDescription,
    resumeIds,
    roleName,
    assistantRole,
    session.status,
    sessionLoaded
  ]);

  function applySessionResult(nextSession: InterviewSession) {
    sessionRef.current = nextSession;
    setSession(nextSession);
  }

  useEffect(() => {
    let active = true;
    async function refreshDiagnostics() {
      try {
        const [healthResponse, stageResponse] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }),
          fetch("/api/stage-status", { cache: "no-store" })
        ]);
        const health = await healthResponse.json();
        const stage = await stageResponse.json();
        if (!active) return;
        setDiagnostics({
          server: healthResponse.ok && health.status === "ok",
          stageConnected: Boolean(stage.connected),
          ttsSupported: Boolean(stage.ttsSupported),
          voiceCount: Number(stage.voiceCount || 0),
          sapiConfigured: Boolean(health.ttsConfigured),
          sapiVoiceCount: Number(health.ttsVoiceCount || 0),
          ttsState: ["idle", "speaking", "ready", "error"].includes(stage.ttsState)
            ? stage.ttsState
            : "idle",
          ttsError: String(stage.ttsError || ""),
          lastSpeechAt: Number(stage.lastSpeechAt || 0),
          mediaReady: Boolean(stage.mediaReady)
        });
        setManagementNetwork({
          reachable: Boolean(health.managementReachable),
          rttMs: Number.isFinite(Number(health.managementRttMs)) ? Number(health.managementRttMs) : null
        });
      } catch {
        if (active) {
          setDiagnostics((current) => ({ ...current, server: false, stageConnected: false }));
          setManagementNetwork({ reachable: false, rttMs: null });
        }
      }
    }
    void refreshDiagnostics();
    const timer = window.setInterval(refreshDiagnostics, 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function act(payload: object) {
    setBusy(true);
    setError("");
    try {
      applySessionResult(await sessionAction(payload));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  useAgentE2eTurn({
    enabled: automaticFollowup && session.status === "running",
    processing: busy || answerPending,
    aiSpeaking: diagnostics.ttsState === "speaking",
    getExpectedRevision: () => sessionRef.current.revision,
    onTurn: async ({ answer, question, expectedRevision }) => {
      setAnswerPending(true);
      setPendingFinalText(answer);
      try {
        return await act({ action: "e2e_turn", answer, question, expectedRevision });
      } finally {
        setAnswerPending(false);
        setPendingFinalText("");
      }
    },
    onBlocked: (message) => {
      if (sessionRef.current.status === "running") setError(message);
    }
  });

  function sayManual(event: FormEvent) {
    event.preventDefault();
    const value = manualText.trim();
    if (!value) return;
    setBusy(true); setError("");
    void sendAgentCommand({ id: crypto.randomUUID(), action: "say", text: value, expectedRevision: sessionRef.current.revision, context: agentCommandContext() })
      .then(() => act({ action: "say", text: value }))
      .then(() => setManualText(""))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Agent 播报失败"))
      .finally(() => setBusy(false));
  }

  function agentCommandContext() {
    const current = sessionRef.current;
    return { v: 1 as const, role: current.assistantRole, topic: current.roleName, history: current.transcript.slice(-20).map((item) => ({ role: item.role, text: item.text })), resumeIds: current.resumeIds || [] };
  }

  function retryLastQuestion() {
    const revision = sessionRef.current.revision;
    setBusy(true); setError("");
    void sendAgentCommand({ id: crypto.randomUUID(), action: "retry", expectedRevision: revision, context: agentCommandContext() })
      .then((result) => act({ action: "agentRetryResult", question: String(result.result.question || ""), expectedRevision: revision }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Agent 重试失败"))
      .finally(() => setBusy(false));
  }

  function correctLastAnswer() {
    const currentQuestion = sessionRef.current.transcript.at(-1);
    const currentAnswer = sessionRef.current.transcript.at(-2);
    if (
      sessionRef.current.status !== "running" ||
      currentAnswer?.role !== "candidate" ||
      currentQuestion?.role !== "interviewer"
    ) return;
    const corrected = window.prompt(
      "修正最近一条对方回答。保存后会根据修正内容重新生成当前回应：",
      currentAnswer.text
    );
    if (corrected === null || !corrected.trim() || corrected.trim() === currentAnswer.text) return;
    const revision = sessionRef.current.revision;
    setBusy(true); setError("");
    void sendAgentCommand({ id: crypto.randomUUID(), action: "correct", answer: corrected.trim(), expectedRevision: revision, context: agentCommandContext() })
      .then((result) => act({ action: "agentCorrectionResult", answer: corrected.trim(), question: String(result.result.question || ""), expectedRevision: revision }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Agent 修正失败"))
      .finally(() => setBusy(false));
  }

  const autoStartDecision = decideAutoSessionStart({
    bridgeState: autoBridgeStatus.state,
    bridgeSessionKey: autoBridgeStatus.sessionKey,
    sessionStatus: session.status,
    assistantRole,
    pending: autoStartPending,
    attemptedSessionKey: autoStartAttemptedRef.current
  });
  const timelineSubtitleLines = selectTimelineSubtitleLines({
    lines: subtitleLines,
    status: session.status,
    finishedAt: session.finishedAt
  });
  function updateFollowState(event: TranscriptFollowEvent) {
    const next = reduceTranscriptFollowState(followStateRef.current, event);
    followStateRef.current = next;
    setFollowingLatest(next.mode !== "reviewing-history");
  }

  function scheduleScrollToLatest() {
    const messages = messagesRef.current;
    if (!messages || followStateRef.current.mode === "reviewing-history") return;
    if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
    updateFollowState({ type: "programmatic-start" });
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null;
      messages.scrollTop = messages.scrollHeight;
      window.requestAnimationFrame(() => {
        updateFollowState({
          type: "programmatic-end",
          nearBottom: isTranscriptNearBottom(messages),
        });
      });
    });
  }

  function scrollToLatest() {
    followStateRef.current = createTranscriptFollowState();
    setFollowingLatest(true);
    scheduleScrollToLatest();
  }

  useLayoutEffect(() => {
    scheduleScrollToLatest();
  }, [session.transcript, timelineSubtitleLines, pendingFinalText, answerPending]);

  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateFollowState({ type: "content-resized" });
      scheduleScrollToLatest();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
    };
  }, []);
  const liveCandidateLine = session.status === "running" ? timelineSubtitleLines.at(-1) : undefined;
  const conversationStatus = diagnostics.ttsState === "error"
    ? `播报失败：${diagnostics.ttsError || "请检查助手舞台"}`
    : diagnostics.ttsState === "speaking"
      ? "AI 正在播报"
      : answerPending
        ? "正在生成 AI 回复"
        : liveCandidateLine
          ? "对方正在说话"
          : session.status === "running"
            ? "等待对方说话"
            : autoStartError || autoStartDecision.message;

  function retryAutoStart() {
    autoStartAttemptedRef.current = "";
    setAutoStartError("");
    setAutoStartRetry((value) => value + 1);
  }

  return (
    <main className="console workspacePage">
      <header className="topbar">
        <div>
          <p className="eyebrow">LIVE INTERACTION</p>
          <h1>虚拟助手工作台</h1>
        </div>
        <div className="topbarRight">
          <AppChrome
            current="workspace"
            showAccount={false}
            upload={{
              candidateName,
              selectedIds: resumeIds,
              onChangeSelection: setResumeIds,
              open: uploadOpen,
              onOpenChange: setUploadOpen
            }}
          />
          <UserAccountMenu current="workspace" onOpenUpload={() => setUploadOpen(true)} />
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      <IntegrationAlerts missing={readiness.missing} />

      <section className="consoleGrid">
        <article className="card setup">
          <div className="cardHeading">
            <h2>会话设置</h2>
            <span className={`pill ${session.status}`}>{session.status}</span>
          </div>
          <label>互动对象<input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} placeholder="例如：张同学" /></label>
          <label>
            助手角色
            <select
              value={assistantRole}
              disabled={session.status === "running"}
              onChange={(event) => setAssistantRole(event.target.value as AssistantRole | "")}
            >
              <option value="">请选择助手角色</option>
              {assistantRoleIds.map((role) => <option key={role} value={role}>{builtInRoleProfiles[role].label}</option>)}
            </select>
          </label>
          {resumeIds.length > 0 ? (
            <p className="muted resumeHint">本场已选 {resumeIds.length} 份参考资料（右上角可调整）。</p>
          ) : null}
          <label>对话主题<input value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="例如：项目交流" /></label>
          <label>
            补充说明
            <textarea
              className="compactTextarea"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              placeholder="粘贴相关说明，AI 会据此继续对话"
            />
          </label>
          <label>
            对话重点
            <input
              value={interviewFocus}
              onChange={(e) => setInterviewFocus(e.target.value)}
              placeholder="例如：项目经历、性能优化"
            />
          </label>
          <label className="consentCheck">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
            />
            <span>AI 开场时告知对方本次互动由 AI 协助、会保存记录并由人工复核。</span>
          </label>
          {readiness.ready ? <button disabled={busy || session.status === "running" || !assistantRole} onClick={async () => { if (await act({ action: "start", candidateName, assistantRole, roleName, jobDescription, interviewFocus, consentConfirmed, resumeIds: resumeIds.length ? resumeIds : undefined })) setConsentConfirmed(false); }}>{session.status === "running" ? "当前互动进行中" : assistantRole ? "开始新互动" : "请选择助手角色"}</button> : <a className="buttonLink primary" href="/settings">前往设置完成检测</a>}
          {session.status !== "running" && <p className="muted">新会话将使用管理端当前启用的语音方案线路；线路无效时 LiveKit Agent 会明确拒绝启动。</p>}
          <p className={autoStartError ? "error" : "muted"} aria-live="polite">
            自动对话：{autoStartPending ? "正在开始并准备开场播报…" : autoStartError || autoStartDecision.message}
          </p>
          {autoStartError && autoBridgeStatus.sessionKey ? (
            <button className="secondary" type="button" disabled={autoStartPending} onClick={retryAutoStart}>
              重试自动开始
            </button>
          ) : null}
          <button className="secondary" disabled={busy || session.status !== "running"} onClick={() => act({ action: "finish" })}>结束互动</button>
          {session.status === "finished" && <a className="textLink" href="/records">查看或生成本次互动纪要 →</a>}
        </article>
        <section className="workspaceMain" aria-label="对话工作区">
          <article className="card transcript">
          <div className="cardHeading">
            <h2>对话记录</h2>
            <div className="transcriptMeta">
              <span className="conversationStatus" aria-live="polite">{conversationStatus}</span>
              <span>
                {session.transcript.filter((item) =>
                  item.role === "interviewer" &&
                  item.kind !== "manual" &&
                  item.kind !== "closing"
                ).length} 问
              </span>
              {session.sessionId && <a href="/api/session/export">JSON</a>}
              {session.sessionId && <a href="/api/session/export?format=markdown">Markdown</a>}
              <button
                className="secondary"
                type="button"
                disabled={
                  busy ||
                  session.status !== "running" ||
                  session.transcript.at(-1)?.role !== "interviewer" ||
                  !session.transcript.some((item) => item.role === "candidate")
                }
                onClick={retryLastQuestion}
              >
                重生成本题
              </button>
              <button
                className="secondary"
                type="button"
                disabled={
                  busy ||
                  session.status !== "running" ||
                  session.transcript.at(-2)?.role !== "candidate" ||
                  session.transcript.at(-1)?.role !== "interviewer"
                }
                onClick={correctLastAnswer}
              >
                修正最近回答
              </button>
            </div>
          </div>
          <div
            className="messages"
            ref={messagesRef}
            tabIndex={0}
            onWheel={(event) => {
              if (event.deltaY < 0) updateFollowState({ type: "user-scroll-up" });
            }}
            onPointerDown={() => updateFollowState({ type: "user-scroll-up" })}
            onTouchStart={() => updateFollowState({ type: "user-scroll-up" })}
            onKeyDown={(event) => {
              if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
                updateFollowState({ type: "user-scroll-up" });
              }
            }}
            onScroll={(event) => {
              const nearBottom = isTranscriptNearBottom(event.currentTarget);
              updateFollowState({ type: "scroll-position", nearBottom });
            }}
          >
            <div className="messagesContent" ref={messagesContentRef}>
            {session.transcript.length === 0 && timelineSubtitleLines.length === 0 && (
              <p className="muted">开始互动后，对话会显示在这里。</p>
            )}
            {session.transcript.map((item, index) => (
              <div className={`message ${item.role}`} key={`${item.at}-${index}`}>
                <strong>{transcriptSpeakerLabel(session.assistantRole, item.role)}</strong>
                <p>{item.text}</p>
              </div>
            ))}
            {pendingFinalText ? (
              <div className="message candidate live" aria-live="polite">
                <strong>对方</strong>
                <p>{pendingFinalText}</p>
                <small>已确认，正在生成 AI 回复…</small>
              </div>
            ) : timelineSubtitleLines.map((line) => (
              <div
                className="message candidate live subtitlePreview"
                aria-live="polite"
                key={`subtitle-${line.sessionId}-${line.utteranceId}`}
              >
                <strong>{line.final ? "对方字幕 · 已确认" : "对方正在说"}</strong>
                <p>{line.text}</p>
                <small>
                  {session.status === "running"
                    ? "识别中，确认后写入记录"
                    : session.status === "finished"
                      ? "互动已结束，未进入正式记录"
                      : "尚未进入正式记录"}
                </small>
              </div>
            ))}
            </div>
          </div>
          {!followingLatest ? (
            <button className="returnToLatest" type="button" onClick={scrollToLatest}>回到最新</button>
          ) : null}
          </article>

          <article className="card controls">
          <h2>AI 人工播报</h2>
          <form className="inlineForm" onSubmit={sayManual}>
            <input value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="让虚拟助手直接说一句话" />
            <button disabled={busy || session.status !== "running"}>播报</button>
          </form>
          </article>
        </section>

        <aside className="workspaceTools" aria-label="会话工具">
          <MeetingBridgeCard />
          <InterventionControls onAiPauseChange={(paused) => setAutomaticFollowup(!paused)} />
        </aside>
      </section>
    </main>
  );
}
