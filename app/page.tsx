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
import { useAutoAnswerSubmit } from "../features/rtc/auto-answer-submit";
import { UserAccountMenu } from "../features/settings/user-account-menu";
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

// 采集开启后超过该时长仍无任何语音片段时，提示用户检查共享音频/对方是否说话。
const CAPTURE_SILENCE_WARN_MS = 45_000;

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
  const lastCaptureActivityRef = useRef(0);
  const [capturingAudio, setCapturingAudio] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [audioSource, setAudioSource] = useState("");
  const [automaticFollowup, setAutomaticFollowup] = useState(true);
  const [echoGuardActive, setEchoGuardActive] = useState(false);
  const [candidateSpeaking, setCandidateSpeaking] = useState(false);
  const [captureSilent, setCaptureSilent] = useState(false);
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

  // 采集开启后长时间没有任何语音片段（未触发 VAD/未产生转写）时提示静默，避免采集失败无感知。
  useEffect(() => {
    if (!capturingAudio) {
      setCaptureSilent(false);
      return;
    }
    const timer = window.setInterval(() => {
      const lastActivity = lastCaptureActivityRef.current;
      setCaptureSilent(lastActivity > 0 && Date.now() - lastActivity > CAPTURE_SILENCE_WARN_MS);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [capturingAudio]);

  // 采集状态接入 stage-status 上报，舞台/服务端可看到“未采集/采集中/静默”等静默失败。
  // 采集期间每 5 秒心跳保活，服务端 8 秒未刷新视为过期。
  useEffect(() => {
    const report = () => {
      const captureState = capturingAudio ? (captureSilent ? "silent" : "capturing") : "off";
      void fetch("/api/stage-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureState,
          captureSource: capturingAudio ? audioSource : ""
        })
      }).catch(() => undefined);
    };
    report();
    if (!capturingAudio) return;
    const timer = window.setInterval(report, 5_000);
    return () => window.clearInterval(timer);
  }, [capturingAudio, captureSilent, audioSource]);

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

  // 字幕 final 行自动作为对方回答提交（取代已移除的手动转写输入框）。
  useAutoAnswerSubmit({
    enabled: automaticFollowup && session.status === "running" && !busy,
    aiSpeaking: diagnostics.ttsState === "speaking",
    getGate: () => ({
      sessionStatus: sessionRef.current.status,
      currentRevision: sessionRef.current.revision,
      lastTranscriptRole: sessionRef.current.transcript.at(-1)?.role
    }),
    onAnswer: (text) => void act({ action: "answer", answer: text, expectedRevision: sessionRef.current.revision })
  });

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
      lastCaptureActivityRef.current = Date.now();
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
        lastCaptureActivityRef.current = Date.now();
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
    lastCaptureActivityRef.current = Date.now();
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
                setError("检测到对话轮次已变化，这段转写未自动提交，请稍后重试。");
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
              throw cause;
            } finally {
              setBusy(false);
            }
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
    lastCaptureActivityRef.current = 0;
    setCaptureSilent(false);
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
