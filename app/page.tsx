"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { InterviewSession } from "../lib/interview";
import { ObsControl } from "../features/obs/obs-control";
import { VirtualCameraPreview } from "../features/obs/virtual-camera-preview";
import { AudioRouteControl } from "../features/audio/audio-route-control";
import {
  advanceEchoGuard,
  armEchoGuard as createEchoGuard,
  idleEchoGuard,
  type EchoGuardState
} from "../features/audio/echo-guard";
import { canAutoSubmitTranscription } from "../features/audio/transcription-turn";
import { describeTtsError } from "../features/audio/tts-error";
import type { MicVAD } from "@ricky0123/vad-web/dist/real-time-vad";
import { ModelSettings } from "../features/settings/model-settings";
import { RtcSettings } from "../features/settings/rtc-settings";
import { getInterviewReadiness } from "../features/readiness/interview-readiness";
import { MeetingHandoffControl } from "../features/meeting/meeting-handoff-control";

type AvatarMetadata = {
  available: boolean;
  kind?: "image" | "video";
  mimeType?: string;
  originalName?: string;
  size?: number;
  version?: string;
};

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
  transcriptionProvider: "openai" | "whisper-cpp";
};

type ArchivedSessionSummary = {
  sessionId: string;
  candidateName: string;
  roleName: string;
  startedAt: string | null;
  finishedAt: string | null;
  questionCount: number;
  reportReady: boolean;
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
  report: null
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
  const [answer, setAnswer] = useState("");
  const [manualText, setManualText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatar, setAvatar] = useState<AvatarMetadata>({ available: false });
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
    transcriptionProvider: "openai"
  });
  const captureActiveRef = useRef(false);
  const captureStreamRef = useRef<MediaStream | null>(null);
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
  const [history, setHistory] = useState<ArchivedSessionSummary[]>([]);
  const [testingSpeech, setTestingSpeech] = useState(false);
  const [speechTestRequestedAt, setSpeechTestRequestedAt] = useState(0);
  const [obsConnected, setObsConnected] = useState(false);
  const [virtualCameraActive, setVirtualCameraActive] = useState(false);
  const [virtualCameraVerified, setVirtualCameraVerified] = useState(false);
  const [virtualAudioReady, setVirtualAudioReady] = useState(false);
  const [meetingPreviewConfirmed, setMeetingPreviewConfirmed] = useState(false);

  const handleObsStatus = useCallback((status: {
    connected: boolean;
    virtualCameraActive: boolean;
  }) => {
    setObsConnected(status.connected);
    setVirtualCameraActive(status.virtualCameraActive);
    if (!status.virtualCameraActive) setVirtualCameraVerified(false);
  }, []);
  const handleCameraVerified = useCallback((verified: boolean) => {
    setVirtualCameraVerified(verified);
  }, []);
  const handleVirtualAudioReady = useCallback((ready: boolean) => {
    setVirtualAudioReady(ready);
  }, []);
  const handleMeetingPreviewConfirmed = useCallback((confirmed: boolean) => {
    setMeetingPreviewConfirmed(confirmed);
  }, []);

  const speechReady =
    (diagnostics.sapiConfigured || (diagnostics.ttsSupported && diagnostics.voiceCount > 0)) &&
    diagnostics.ttsState !== "error" &&
    speechTestRequestedAt > 0 &&
    diagnostics.lastSpeechAt >= speechTestRequestedAt;
  const readiness = getInterviewReadiness({
    modelConfigured: diagnostics.modelConfigured,
    stageConnected: diagnostics.stageConnected,
    mediaReady: diagnostics.mediaReady,
    speechReady,
    obsConnected,
    virtualCameraActive,
    virtualCameraVerified,
    virtualAudioReady,
    meetingPreviewConfirmed
  });

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setError("无法读取面试会话"));
    fetch("/api/avatar", { cache: "no-store" })
      .then((response) => response.json())
      .then(setAvatar)
      .catch(() => setError("无法读取数字人素材"));
    void refreshHistory();
  }, []);

  async function refreshHistory() {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (response.ok) setHistory(await response.json());
    } catch {
      // History is secondary; current interview remains usable.
    }
  }

  async function deleteHistoryItem(item: ArchivedSessionSummary) {
    const label = `${item.candidateName || "未命名候选人"} · ${item.roleName || "未填写岗位"}`;
    if (!window.confirm(`确定永久删除“${label}”的本地面试记录和 AI 纪要吗？此操作无法恢复。`)) return;
    setError("");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "删除失败");
      if (sessionRef.current.sessionId === item.sessionId) {
        setSession(emptySession);
      }
      await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  }

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    automaticFollowupRef.current = automaticFollowup;
  }, [automaticFollowup]);

  useEffect(() => {
    stageConnectedRef.current = diagnostics.stageConnected;
  }, [diagnostics.stageConnected]);

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
          transcriptionProvider: health.transcriptionProvider === "whisper-cpp" ? "whisper-cpp" : "openai"
        });
      } catch {
        if (active) setDiagnostics((current) => ({ ...current, server: false, stageConnected: false }));
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
      await refreshHistory();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function playTestSpeech() {
    setTestingSpeech(true);
    setSpeechTestRequestedAt(0);
    setError("");
    try {
      const response = await fetch("/api/stage-test-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "你好，这是一段面试音视频线路测试。" })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "测试语音发送失败");
      setSpeechTestRequestedAt(Number(data.createdAt || Date.now()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试语音发送失败");
    } finally {
      setTestingSpeech(false);
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
      "修正最近一条候选人回答。保存后会根据修正内容重新生成当前追问：",
      currentAnswer.text
    );
    if (corrected === null || !corrected.trim() || corrected.trim() === currentAnswer.text) return;
    void act({ action: "correctLastAnswer", answer: corrected.trim() });
  }

  async function uploadAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("avatar") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const body = new FormData();
      body.append("avatar", file);
      const response = await fetch("/api/avatar", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "上传失败");
      setAvatar(data);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function clearAvatar() {
    setUploading(true);
    setError("");
    try {
      const response = await fetch("/api/avatar", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "恢复失败");
      setAvatar(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setUploading(false);
    }
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
                setError("检测到面试轮次已变化，这段转写已放入输入框，请人工确认后再提交。");
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
    captureStreamRef.current?.getTracks().forEach((track) => track.stop());
    captureStreamRef.current = null;
    setCapturingAudio(false);
    setAudioSource("");
    setCandidateSpeaking(false);
    vadSpeechRevisionRef.current = 0;
  }

  return (
    <main className="console">
      <header className="topbar">
        <div>
          <p className="eyebrow">SINGLE INTERVIEW · LOW COST</p>
          <h1>AI 面试官控制台</h1>
        </div>
        <a className="stageLink" href="/stage" target="_blank">打开数字人舞台 ↗</a>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="consoleGrid">
        <ObsControl onStatusChange={handleObsStatus} />
        <VirtualCameraPreview
          active={virtualCameraActive}
          onVerifiedChange={handleCameraVerified}
        />
        <AudioRouteControl onReadyChange={handleVirtualAudioReady} />
        <MeetingHandoffControl
          prerequisitesReady={
            obsConnected &&
            virtualCameraActive &&
            virtualCameraVerified &&
            virtualAudioReady
          }
          onConfirmedChange={handleMeetingPreviewConfirmed}
        />
        <ModelSettings />
        <RtcSettings />

        <article className="card mediaSetup">
          <div className="cardHeading">
            <h2>你的数字人画面</h2>
            <span>{avatar.available ? "已启用" : "使用默认头像"}</span>
          </div>
          <div className="mediaPreview">
            {avatar.available && avatar.kind === "video" && (
              <video src={`/api/avatar/media?v=${avatar.version}`} autoPlay loop muted playsInline />
            )}
            {avatar.available && avatar.kind === "image" && (
              <img src={`/api/avatar/media?v=${avatar.version}`} alt="当前数字人素材" />
            )}
            {!avatar.available && <span>上传生成图片或待机视频</span>}
          </div>
          <form onSubmit={uploadAvatar}>
            <input name="avatar" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" />
            <button disabled={uploading}>{uploading ? "正在上传…" : "上传并应用"}</button>
          </form>
          <p className="muted">
            JPEG、PNG、WebP、MP4 或 WebM，最大 50MB。视频会静音循环，AI 语音单独播报。
          </p>
          {avatar.available && (
            <>
              <p className="fileMeta">{avatar.originalName} · {Math.max(1, Math.round((avatar.size || 0) / 1024))}KB</p>
              <button className="secondary" disabled={uploading} onClick={clearAvatar}>恢复默认头像</button>
            </>
          )}
        </article>

        <article className="card readiness">
          <div className="cardHeading">
            <h2>面试前输出门禁</h2>
            <span className={readiness.ready ? "ready" : ""}>
              {readiness.ready ? "可以开始" : `还差 ${readiness.missing.length} 项`}
            </span>
          </div>
          <div className="checks">
            {readiness.items.map((item) => (
              <Check
                key={item.id}
                label={item.label}
                ok={item.ready}
                detail={item.ready ? "已确认" : "请完成上方对应配置与检测"}
              />
            ))}
          </div>
          <p className="muted">
            摄像头预览通过后可停止预览释放设备，再进入候选人选择的会议软件完成最后一跳确认。
            上游设备状态变化会撤销这项确认。
          </p>
        </article>

        <article className="card setup">
          <div className="cardHeading">
            <h2>会话设置</h2>
            <span className={`pill ${session.status}`}>{session.status}</span>
          </div>
          <label>候选人姓名<input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} placeholder="例如：张同学" /></label>
          <label>应聘岗位<input value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="例如：前端开发工程师" /></label>
          <label>
            岗位要求
            <textarea
              className="compactTextarea"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              placeholder="粘贴 JD 或核心职责，AI 会据此追问"
            />
          </label>
          <label>
            面试重点
            <input
              value={interviewFocus}
              onChange={(e) => setInterviewFocus(e.target.value)}
              placeholder="例如：项目真实性、性能优化"
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
            <span>我已向候选人说明本次面试由 AI 协助、会保存记录，并提供人工复核渠道。</span>
          </label>
          <button
            disabled={
              busy ||
              !consentConfirmed ||
              !readiness.ready ||
              session.status === "running"
            }
            onClick={() => act({
              action: "start",
              candidateName,
              roleName,
              jobDescription,
              interviewFocus,
              maxQuestions,
              consentConfirmed
            })}
          >
            {session.status === "running"
              ? "当前面试进行中"
              : !diagnostics.modelConfigured
                ? "请先配置 AI 模型"
                : !readiness.ready
                  ? `完成输出检测后开始（还差 ${readiness.missing.length} 项）`
                : "开始新面试"}
          </button>
          {!diagnostics.modelConfigured && (
            <p className="muted">先在“AI 模型设置”保存并测试远程模型，或配置本机 Ollama。</p>
          )}
          {diagnostics.modelConfigured && session.status !== "running" && (
            <p className="muted">
              输出门禁全部通过后才能开始；开始时还会用 GET /models 做一次无推理连接检查，不产生模型调用费用。
            </p>
          )}
          <button className="secondary" disabled={busy || session.status !== "running"} onClick={() => act({ action: "finish" })}>结束面试</button>
        </article>

        <article className="card diagnostics">
          <div className="cardHeading"><h2>OBS 输出自检</h2><span>自动刷新</span></div>
          <div className="checks">
            <Check label="本地服务" ok={diagnostics.server} detail={diagnostics.server ? "正常" : "不可用"} />
            <Check label="AI 模型" ok={diagnostics.modelConfigured} detail={diagnostics.modelConfigured ? "已配置" : "尚未配置"} />
            <Check label="数字人舞台" ok={diagnostics.stageConnected} detail={diagnostics.stageConnected ? "页面在线" : "请在 OBS 或浏览器打开 /stage"} />
            <Check
              label="中文语音"
              ok={
                speechReady
              }
              detail={
                diagnostics.ttsState === "error"
                  ? describeTtsError(diagnostics.ttsError)
                  : speechReady
                    ? `最近播放成功 ${new Date(diagnostics.lastSpeechAt).toLocaleTimeString()}`
                    : speechTestRequestedAt > 0 && diagnostics.ttsState === "speaking"
                      ? "测试语音正在播放"
                    : diagnostics.sapiConfigured
                      ? `SAPI ${diagnostics.sapiVoiceCount} 个中文声音，请播放测试语音`
                      : diagnostics.ttsSupported && diagnostics.voiceCount > 0
                        ? `Web Speech ${diagnostics.voiceCount} 个声音（兜底），请播放测试语音`
                      : "当前舞台不支持 TTS"
              }
            />
            <Check label="画面素材" ok={diagnostics.stageConnected && diagnostics.mediaReady} detail={diagnostics.mediaReady ? "已就绪" : "仍在加载或格式不兼容"} />
            <Check
              label="语音转写"
              ok={diagnostics.transcriptionReady}
              detail={
                diagnostics.transcriptionReady
                  ? `${diagnostics.transcriptionProvider} 已就绪`
                  : diagnostics.transcriptionConfigured
                    ? `${diagnostics.transcriptionProvider} 未启动或不可达`
                    : "尚未配置转写服务"
              }
            />
          </div>
          <button
            disabled={!diagnostics.stageConnected || testingSpeech}
            onClick={() => void playTestSpeech()}
          >
            {testingSpeech ? "正在发送…" : "播放测试语音"}
          </button>
          <p className="muted">
            测试语音不写入面试记录。舞台完整播放成功后，中文语音门禁才会通过；再确认 OBS 和会议软件的音量表有波动。
          </p>
        </article>

        <article className="card transcript">
          <div className="cardHeading">
            <h2>面试记录</h2>
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
            {session.transcript.length === 0 && <p className="muted">开始面试后，对话会显示在这里。</p>}
            {session.transcript.map((item, index) => (
              <div className={`message ${item.role}`} key={`${item.at}-${index}`}>
                <strong>{item.role === "interviewer" ? "AI 面试官" : "候选人"}</strong>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="card report">
          <div className="cardHeading">
            <h2>AI 面试纪要</h2>
            <span>{session.report ? "已生成" : "等待生成"}</span>
          </div>
          {!session.report ? (
            <>
              <p className="muted">
                面试结束后，根据原始回答生成证据型纪要。AI 不提供录用建议或候选人排名。
              </p>
              <button
                disabled={busy || session.status !== "finished" || !diagnostics.modelConfigured}
                onClick={() => act({ action: "generateReport" })}
              >
                {busy ? "正在生成…" : "生成面试纪要"}
              </button>
            </>
          ) : (
            <div className="reportBody">
              <p>{session.report.summary}</p>
              <ReportList title="明确表现" items={session.report.strengths} />
              <ReportList title="建议人工追核" items={session.report.followUps} />
              <ReportList title="信息限制" items={session.report.limitations} />
              {session.report.evidence.length > 0 && (
                <section>
                  <h3>证据记录</h3>
                  <div className="reportEvidence">
                    {session.report.evidence.map((item) => (
                      <article key={`${item.topic}-${item.observation}`}>
                        <strong>{item.topic}</strong>
                        <p>{item.observation}</p>
                        {item.quotes.map((quote) => <blockquote key={quote}>“{quote}”</blockquote>)}
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <p className="humanReview">需由招聘人员结合岗位标准和原始记录进行人工复核。</p>
            </div>
          )}
        </article>

        <article className="card history">
          <div className="cardHeading">
            <h2>历史面试</h2>
            <span>{history.length} 场</span>
          </div>
          {history.length === 0 ? (
            <p className="muted">结束一场面试后会自动归档。</p>
          ) : (
            <div className="historyList">
              {history.slice(0, 20).map((item) => (
                <div key={item.sessionId}>
                  <div>
                    <strong>{item.candidateName || "未命名候选人"}</strong>
                    <span>{item.roleName || "未填写岗位"} · {item.questionCount} 问</span>
                  </div>
                  <span>{item.reportReady ? "含纪要" : "仅记录"}</span>
                  <a href={`/api/sessions/${encodeURIComponent(item.sessionId)}/export`}>JSON</a>
                  <a href={`/api/sessions/${encodeURIComponent(item.sessionId)}/export?format=markdown`}>Markdown</a>
                  <button
                    className="historyDelete"
                    type="button"
                    onClick={() => deleteHistoryItem(item)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="card controls">
          <h2>候选人回答</h2>
          <p className="muted">可采集会议窗口/整个屏幕的系统音频，转写结果会追加到下方文本框；提交前可以人工校对。</p>
          <label className="autoFollowup">
            <input
              type="checkbox"
              checked={automaticFollowup}
              disabled={capturingAudio}
              onChange={(event) => setAutomaticFollowup(event.target.checked)}
            />
            <span>
              <strong>候选人说完后自动追问</strong>
              <small>本机 VAD 检测约 2.5 秒静音后自动转写并提交；面试中可随时停止听取。</small>
            </span>
          </label>
          <div className="captureBar">
            {!capturingAudio ? (
              <button
                type="button"
                disabled={!diagnostics.transcriptionReady}
                onClick={startAudioCapture}
              >
                开始听取候选人
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
                    ? "检测到候选人说话"
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
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="输入候选人的回答…" />
            <button disabled={busy || session.status !== "running"}>{busy ? "正在生成…" : "生成追问"}</button>
          </form>
          <div className="divider" />
          <h2>人工接管</h2>
          <form className="inlineForm" onSubmit={sayManual}>
            <input value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="让数字人直接说一句话" />
            <button disabled={busy || session.status !== "running"}>播报</button>
          </form>
        </article>
      </section>
    </main>
  );
}

function Check({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="check">
      <i className={ok ? "ok" : ""}>{ok ? "✓" : "!"}</i>
      <div><strong>{label}</strong><span>{detail}</span></div>
    </div>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}
