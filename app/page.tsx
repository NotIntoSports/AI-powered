"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { InterviewSession } from "../lib/interview";
import {
  advanceEchoGuard,
  armEchoGuard as createEchoGuard,
  idleEchoGuard,
  type EchoGuardState
} from "../features/audio/echo-guard";
import { canAutoSubmitTranscription } from "../features/audio/transcription-turn";
import type { MicVAD } from "@ricky0123/vad-web/dist/real-time-vad";
import {
  loadRemoteMonitorEnabled,
  subscribeRemoteMonitor
} from "../features/audio/remote-monitor";
import { InterventionControls } from "../features/intervention/intervention-controls";
import { MeetingBridgeCard } from "../features/rtc/meeting-bridge-card";
import { LiveSubtitles } from "../features/subtitles/live-subtitles";
import { getInterviewReadiness } from "../features/readiness/interview-readiness";
import { getSnapshotReadiness, invalidateDeviceReadiness, loadReadinessSnapshot } from "../features/readiness/readiness-snapshot";
import { loadOutputMode, subscribeOutputMode, type OutputMode } from "../features/readiness/output-mode";
import { AppChrome } from "../features/settings/app-chrome";
import { IntegrationAlerts } from "../features/meeting/integration-alerts";
import { setManagementNetwork } from "../features/rtc/network-quality";

type Diagnostics = {
  server: boolean;
  modelConfigured: boolean;
  stageConnected: boolean;
  ttsSupported: boolean;
  voiceCount: number;
  sapiConfigured: boolean;
  sapiVoiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
  transcriptionConfigured: boolean;
  transcriptionReady: boolean;
  transcriptionSource: "aliyun" | "volcengine" | "management" | "environment" | "whisper-cpp" | "none";
};

const emptySession: InterviewSession = {
  sessionId: "",
  revision: 0,
  status: "idle",
  speakingText: "",
  candidateName: "",
  roleName: "",
  jobDescription: "",
  interviewFocus: "",
  maxQuestions: 6,
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
  const [jobDescription, setJobDescription] = useState("");
  const [interviewFocus, setInterviewFocus] = useState("");
  const [maxQuestions, setMaxQuestions] = useState(6);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [resumeIds, setResumeIds] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [manualText, setManualText] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    server: false,
    modelConfigured: false,
    stageConnected: false,
    ttsSupported: false,
    voiceCount: 0,
    sapiConfigured: false,
    sapiVoiceCount: 0,
    ttsState: "idle",
    ttsError: "",
    lastSpeechAt: 0,
    mediaReady: false,
    transcriptionConfigured: false,
    transcriptionReady: false,
    transcriptionSource: "none"
  });
  const captureActiveRef = useRef(false);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const vadSpeechRevisionRef = useRef(0);
  const vadCommandRef = useRef<Promise<void>>(Promise.resolve());
  const echoGuardRef = useRef<EchoGuardState>(idleEchoGuard);
  const echoGuardTimerRef = useRef<number | null>(null);
  const automaticFollowupRef = useRef(false);
  const stageConnectedRef = useRef(false);
  const sessionRef = useRef(emptySession);
  const segmentTimerRef = useRef<number | null>(null);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [capturingAudio, setCapturingAudio] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [audioSource, setAudioSource] = useState("");
  const [automaticFollowup, setAutomaticFollowup] = useState(false);
  const [echoGuardActive, setEchoGuardActive] = useState(false);
  const [candidateSpeaking, setCandidateSpeaking] = useState(false);
  const [error, setError] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("real");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [snapshotReadiness, setSnapshotReadiness] = useState(() => getSnapshotReadiness({}));
  const readiness = getInterviewReadiness({
    outputMode,
    modelConfigured: diagnostics.modelConfigured,
    stageConnected: diagnostics.stageConnected,
    mediaReady: diagnostics.mediaReady,
    ...snapshotReadiness
  });

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setError("无法读取当前互动会话"));
    setSnapshotReadiness(getSnapshotReadiness(loadReadinessSnapshot()));
    setOutputMode(loadOutputMode());
    return subscribeOutputMode(() => setOutputMode(loadOutputMode()));
  }, []);

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
    automaticFollowupRef.current = automaticFollowup;
  }, [automaticFollowup]);

  useEffect(() => {
    stageConnectedRef.current = diagnostics.stageConnected;
  }, [diagnostics.stageConnected]);

  useEffect(() => {
    function applyMonitor() {
      const audio = monitorAudioRef.current;
      if (!audio) return;
      audio.muted = !loadRemoteMonitorEnabled();
      if (!audio.muted && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    }
    applyMonitor();
    return subscribeRemoteMonitor(applyMonitor);
  }, []);

  function attachRemoteMonitor(stream: MediaStream) {
    stopRemoteMonitor();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    const audio = new Audio();
    audio.srcObject = new MediaStream(audioTracks);
    audio.autoplay = true;
    audio.muted = !loadRemoteMonitorEnabled();
    monitorAudioRef.current = audio;
    if (!audio.muted) {
      void audio.play().catch(() => undefined);
    }
  }

  function stopRemoteMonitor() {
    const audio = monitorAudioRef.current;
    monitorAudioRef.current = null;
    if (!audio) return;
    audio.pause();
    audio.srcObject = null;
  }

  function queueVadCommand(command: "pause" | "start") {
    const vad = vadRef.current;
    if (!vad) return;
    vadCommandRef.current = vadCommandRef.current
      .catch(() => undefined)
      .then(async () => {
        if (vadRef.current !== vad) return;
        await vad[command]();
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "自动收音状态切换失败");
      });
  }

  function releaseEchoGuard() {
    if (echoGuardTimerRef.current !== null) {
      window.clearTimeout(echoGuardTimerRef.current);
      echoGuardTimerRef.current = null;
    }
    if (echoGuardRef.current.phase === "idle") return;
    echoGuardRef.current = idleEchoGuard;
    setEchoGuardActive(false);
    setCandidateSpeaking(false);
    if (captureActiveRef.current) queueVadCommand("start");
  }

  function armEchoGuard(nextSession: InterviewSession) {
    if (
      !automaticFollowupRef.current ||
      !captureActiveRef.current ||
      !stageConnectedRef.current ||
      !vadRef.current ||
      nextSession.revision <= sessionRef.current.revision ||
      !nextSession.speakingText
    ) return;

    const transition = createEchoGuard(Date.now());
    echoGuardRef.current = transition.state;
    setEchoGuardActive(true);
    setCandidateSpeaking(false);
    if (transition.command) queueVadCommand(transition.command);
    if (echoGuardTimerRef.current !== null) {
      window.clearTimeout(echoGuardTimerRef.current);
    }
    echoGuardTimerRef.current = window.setTimeout(releaseEchoGuard, 30_000);
  }

  function applySessionResult(nextSession: InterviewSession) {
    armEchoGuard(nextSession);
    sessionRef.current = nextSession;
    setSession(nextSession);
  }

  useEffect(() => {
    const transition = advanceEchoGuard(
      echoGuardRef.current,
      diagnostics.ttsState,
      Date.now()
    );
    if (transition.command === "start") {
      releaseEchoGuard();
    } else {
      echoGuardRef.current = transition.state;
    }
  }, [diagnostics.ttsState, diagnostics.lastSpeechAt]);

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
          modelConfigured: Boolean(health.modelConfigured),
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
          mediaReady: Boolean(stage.mediaReady),
          transcriptionConfigured: Boolean(health.transcriptionConfigured),
          transcriptionReady: Boolean(health.transcriptionReady),
          transcriptionSource: health.transcriptionSource === "aliyun" || health.transcriptionSource === "volcengine" || health.transcriptionSource === "management" || health.transcriptionSource === "environment" || health.transcriptionSource === "whisper-cpp" ? health.transcriptionSource : "none"
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

  useEffect(() => () => stopAudioCapture(), []);

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

  async function submitAnswer(event: FormEvent) {
    event.preventDefault();
    const value = answer.trim();
    if (!value) return;
    setAnswer("");
    const succeeded = await act({
      action: "answer",
      answer: value,
      expectedRevision: sessionRef.current.revision
    });
    if (!succeeded) {
      setAnswer((current) => current.trim() || value);
    }
  }

  function sayManual(event: FormEvent) {
    event.preventDefault();
    const value = manualText.trim();
    if (!value) return;
    setManualText("");
    void act({ action: "say", text: value });
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
    void act({ action: "correctLastAnswer", answer: corrected.trim() });
  }

  async function startAudioCapture() {
    setError("");
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      setError("当前浏览器不支持系统音频采集，请使用最新版 Edge 或 Chrome");
      return;
    }
    try {
      const options = {
        video: true,
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "exclude"
      } as DisplayMediaStreamOptions;
      const stream = await navigator.mediaDevices.getDisplayMedia(options);
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("没有采集到音频。请选择整个屏幕或会议窗口，并勾选“共享系统音频”");
      }
      captureStreamRef.current = stream;
      captureActiveRef.current = true;
      setCapturingAudio(true);
      setAudioSource(audioTrack.label || "系统音频");
      attachRemoteMonitor(stream);
      stream.getVideoTracks()[0]?.addEventListener("ended", stopAudioCapture, { once: true });
      if (automaticFollowup) {
        await startVoiceActivityDetection(stream);
      } else {
        recordAudioSegment(stream);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        setError("已取消音频共享");
      } else {
        setError(cause instanceof Error ? cause.message : "无法开始音频采集");
      }
      stopAudioCapture();
    }
  }

  async function startVoiceActivityDetection(stream: MediaStream) {
    const [{ MicVAD }, { encodeWAV }] = await Promise.all([
      import("@ricky0123/vad-web/dist/real-time-vad"),
      import("@ricky0123/vad-web/dist/utils")
    ]);
    const vad = await MicVAD.new({
      model: "v5",
      startOnLoad: false,
      baseAssetPath: "/vendor/vad/",
      onnxWASMBasePath: "/vendor/vad/",
      redemptionMs: 2_500,
      minSpeechMs: 900,
      preSpeechPadMs: 350,
      getStream: async () => new MediaStream(stream.getAudioTracks()),
      pauseStream: async () => undefined,
      resumeStream: async () => new MediaStream(stream.getAudioTracks()),
      onSpeechStart: () => {
        vadSpeechRevisionRef.current = sessionRef.current.revision;
        setCandidateSpeaking(true);
      },
      onVADMisfire: () => {
        vadSpeechRevisionRef.current = 0;
        setCandidateSpeaking(false);
      },
      onSpeechEnd: (audio) => {
        setCandidateSpeaking(false);
        const wav = encodeWAV(audio);
        const capturedRevision = vadSpeechRevisionRef.current || sessionRef.current.revision;
        vadSpeechRevisionRef.current = 0;
        queueTranscription(
          new Blob([wav], { type: "audio/wav" }),
          "audio/wav",
          true,
          capturedRevision
        );
      }
    });
    vadRef.current = vad;
    await vad.start();
  }

  function recordAudioSegment(source: MediaStream) {
    if (!captureActiveRef.current) return;
    const audioStream = new MediaStream(source.getAudioTracks());
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4"
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      setError("当前浏览器没有可用的音频录制格式");
      stopAudioCapture();
      return;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(audioStream, {
      mimeType,
      audioBitsPerSecond: 64_000
    });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      setError("系统音频录制中断");
      stopAudioCapture();
    };
    recorder.onstop = () => {
      if (segmentTimerRef.current !== null) {
        window.clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size > 512) queueTranscription(blob, mimeType);
      if (captureActiveRef.current) recordAudioSegment(source);
    };
    recorder.start();
    segmentTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 10_000);
  }

  function queueTranscription(
    blob: Blob,
    mimeType: string,
    submitAutomatically = false,
    capturedRevision = sessionRef.current.revision
  ) {
    setPendingTranscriptions((count) => count + 1);
    uploadQueueRef.current = uploadQueueRef.current
      .then(async () => {
        const extension = mimeType.includes("mp4") ? "mp4" : "webm";
        const form = new FormData();
        form.append("audio", new File([blob], `meeting-${Date.now()}.${extension}`, { type: mimeType }));
        const response = await fetch("/api/transcribe", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "语音转写失败");
        const text = String(data.text || "").trim();
        if (text) {
          if (submitAutomatically) {
            const current = sessionRef.current;
            if (!canAutoSubmitTranscription({
              sessionStatus: current.status,
              currentRevision: current.revision,
              capturedRevision,
              lastTranscriptRole: current.transcript.at(-1)?.role
            })) {
              if (current.status === "running") {
                setAnswer((existing) => [existing.trim(), text].filter(Boolean).join(" "));
                setError("检测到对话轮次已变化，这段转写已放入输入框，请人工确认后再提交。");
              }
              return;
            }
            setBusy(true);
            try {
              applySessionResult(await sessionAction({
                action: "answer",
                answer: text,
                expectedRevision: capturedRevision
              }));
            } catch (cause) {
              setAnswer((existing) => [existing.trim(), text].filter(Boolean).join(" "));
              throw cause;
            } finally {
              setBusy(false);
            }
          } else {
            setAnswer((current) => [current.trim(), text].filter(Boolean).join(" "));
          }
        }
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "语音转写失败");
      })
      .finally(() => {
        setPendingTranscriptions((count) => Math.max(0, count - 1));
      });
  }

  function stopAudioCapture() {
    captureActiveRef.current = false;
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    recorderRef.current = null;
    const vad = vadRef.current;
    vadRef.current = null;
    if (echoGuardTimerRef.current !== null) {
      window.clearTimeout(echoGuardTimerRef.current);
      echoGuardTimerRef.current = null;
    }
    echoGuardRef.current = idleEchoGuard;
    setEchoGuardActive(false);
    if (vad) void vad.destroy();
    stopRemoteMonitor();
    captureStreamRef.current?.getTracks().forEach((track) => track.stop());
    captureStreamRef.current = null;
    setCapturingAudio(false);
    setAudioSource("");
    setCandidateSpeaking(false);
    vadSpeechRevisionRef.current = 0;
  }

  return (
    <main className="console workspacePage">
      <AppChrome
        current="workspace"
        upload={{
          candidateName,
          selectedIds: resumeIds,
          onChangeSelection: setResumeIds,
          open: uploadOpen,
          onOpenChange: setUploadOpen
        }}
      />
      <header className="topbar">
        <div>
          <p className="eyebrow">LIVE INTERACTION</p>
          <h1>虚拟助手工作台</h1>
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
          <label>
            问题上限
            <input
              type="number"
              min={2}
              max={20}
              value={maxQuestions}
              onChange={(e) => setMaxQuestions(Math.min(20, Math.max(2, Number(e.target.value) || 2)))}
            />
          </label>
          <label className="consentCheck">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
            />
            <span>我已向对方说明本次互动由 AI 协助、会保存记录，并提供人工复核渠道。</span>
          </label>
          {readiness.ready ? <button disabled={busy || !consentConfirmed || session.status === "running"} onClick={() => act({ action: "start", candidateName, roleName, jobDescription, interviewFocus, maxQuestions, consentConfirmed, resumeIds: resumeIds.length ? resumeIds : undefined })}>{session.status === "running" ? "当前互动进行中" : "开始新互动"}</button> : <a className="buttonLink primary" href="/settings">前往设置完成检测</a>}
          {diagnostics.modelConfigured && session.status !== "running" && (
            <p className="muted">
              {outputMode === "virtual"
                ? "虚拟摄像头相关检测通过后才能开始；开始时还会用 GET /models 做一次无推理连接检查，不产生模型调用费用。"
                : "AI 模型已配置后即可开始；虚拟声卡可选。开始时还会用 GET /models 做一次无推理连接检查，不产生模型调用费用。"}
            </p>
          )}
          <button className="secondary" disabled={busy || session.status !== "running"} onClick={() => act({ action: "finish" })}>结束互动</button>
          {session.status === "finished" && <a className="textLink" href="/records">查看或生成本次互动纪要 →</a>}
        </article>
        <section className="workspaceMain" aria-label="对话工作区">
          <article className="card transcript">
          <div className="cardHeading">
            <h2>对话记录</h2>
            <div className="transcriptMeta">
              <span>
                {session.transcript.filter((item) =>
                  item.role === "interviewer" &&
                  item.kind !== "manual" &&
                  item.kind !== "closing"
                ).length}/{session.maxQuestions} 问
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
                onClick={() => act({
                  action: "retryQuestion",
                  expectedRevision: sessionRef.current.revision
                })}
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
          <div className="messages">
            {session.transcript.length === 0 && <p className="muted">开始互动后，对话会显示在这里。</p>}
            {session.transcript.map((item, index) => (
              <div className={`message ${item.role}`} key={`${item.at}-${index}`}>
                <strong>{item.role === "interviewer" ? "AI虚拟助手" : "对方"}</strong>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
          </article>

          <article className="card controls">
          <h2>对方回答</h2>
          <p className="muted">可采集会议窗口/整个屏幕的系统音频，转写结果会追加到下方文本框；提交前可以人工校对。</p>
          <label className="autoFollowup">
            <input
              type="checkbox"
              checked={automaticFollowup}
              disabled={capturingAudio}
              onChange={(event) => setAutomaticFollowup(event.target.checked)}
            />
            <span>
              <strong>对方说完后自动回应</strong>
              <small>本机 VAD 检测约 2.5 秒静音后自动转写并提交；互动中可随时停止听取。</small>
            </span>
          </label>
          <div className="captureBar">
            {!capturingAudio ? (
              <button
                type="button"
                disabled={!diagnostics.transcriptionReady}
                onClick={startAudioCapture}
              >
                开始听取对方
              </button>
            ) : (
              <button type="button" className="danger" onClick={stopAudioCapture}>
                停止听取
              </button>
            )}
            <div>
              <strong>
                {echoGuardActive
                  ? "AI 播报中，已暂停收音"
                  : candidateSpeaking
                    ? "检测到对方说话"
                    : capturingAudio
                      ? "正在聆听"
                      : "未采集"}
              </strong>
              <span>
                {capturingAudio
                  ? `${audioSource} · ${automaticFollowup ? "半双工防回声 · 静音后自动追问" : "每10秒转写"}`
                  : pendingTranscriptions > 0
                    ? `仍有 ${pendingTranscriptions} 段正在转写`
                    : "使用 Edge/Chrome 并勾选共享音频"}
              </span>
            </div>
            {pendingTranscriptions > 0 && <i>{pendingTranscriptions}</i>}
          </div>
          <form onSubmit={submitAnswer}>
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="输入对方的回答…" />
            <button disabled={busy || session.status !== "running"}>{busy ? "正在生成…" : "生成追问"}</button>
          </form>
          <div className="divider" />
          <h2>AI 人工播报</h2>
          <form className="inlineForm" onSubmit={sayManual}>
            <input value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="让虚拟助手直接说一句话" />
            <button disabled={busy || session.status !== "running"}>播报</button>
          </form>
          </article>
        </section>

        <aside className="workspaceTools" aria-label="会话工具">
          <MeetingBridgeCard />
          <LiveSubtitles />
          <InterventionControls onAiPauseChange={(paused) => setAutomaticFollowup(!paused)} />
        </aside>
      </section>
    </main>
  );
}
