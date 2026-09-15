import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, FileText, Hand, MessageSquare, MicOff, Play, RotateCcw, Square, Volume2, Wrench } from "lucide-react";

import * as api from "../../api/commands";
import "../../styles/workspace.css";
import { connectLiveKitRoom, disconnectLiveKitRoom } from "./livekit-room";
import { PreflightIssues } from "./preflight-issues";
import type {
  AgentCommandInput,
  CommandResult,
  RuntimeStatus,
  SessionReplyEvent,
  SessionTranscriptEvent,
  PreflightIssue,
  PublicConfig,
  WebSource,
  MeetingProcess,
  AudioOutputDevice,
  VirtualAudioPreparation,
  RoleScenario,
} from "../../generated/bindings";

const PRESET_SCENARIOS: Record<string, RoleScenario> = {
  "preset-interviewer": "interviewer",
  "preset-hr": "hr",
  "preset-candidate": "candidate",
  "preset-meeting": "meetingAssistant",
  "preset-presenter": "livestreamPresenter",
};

const MEETING_NAMES: Record<string, string> = {
  "teams.exe": "Microsoft Teams", "ms-teams.exe": "Microsoft Teams",
  "wemeetapp.exe": "腾讯会议", "feishu.exe": "飞书", "lark.exe": "Lark",
  "dingtalk.exe": "钉钉", "zoom.exe": "Zoom",
};

const PREPARATION_PHASES: Record<string, string> = {
  checking: "检测安装环境", downloading: "下载安装包", verifying: "校验安装包和签名",
  authorizing: "等待 Windows 管理员授权", installing: "安装驱动", rechecking: "重新检测音频端点",
};

function roleScenario(config: PublicConfig | null, roleId: string): RoleScenario | undefined {
  return config?.roleProfiles.find((role) => role.id === roleId)?.scenario ?? PRESET_SCENARIOS[roleId];
}

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  ({ SESSION_SIDECAR_MISSING: "缺少 AudioBridge 音频组件，请安装或修复音频组件后重试。",
    MEETING_PROCESS_NOT_AVAILABLE: "所选会议已退出或不再可用，请刷新会议进程。",
    SESSION_SIDECAR_INVALID_PID: "请选择有效的会议进程。",
    SESSION_SIDECAR_SPAWN_FAILED: "音频组件启动失败，请检查安装后重试。",
    PLAYBACK_FAILED: "语音未播放成功，文字回答已保留。请检查所选音频设备。",
    PLAYBACK_START_FAILED: "无法启动语音播放，请检查 AudioBridge 音频组件。",
    PLAYBACK_TIMEOUT: "语音播放超时，已停止输出。",
    PLAYBACK_CANCELLED: "语音播放已取消。",
    PLAYBACK_NOT_CONFIRMED: "音频组件未确认播放完成，不能标记为已播报。文字回答已保留。",
  }[error.code] ?? `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`);

const ACTIVE_PHASES = new Set([
  "preparing",
  "listening",
  "thinking",
  "speaking",
  "stopping",
  "recovering",
  "blocked",
]);

const PHASE_LABELS: Record<string, string> = {
  idle: "未开始",
  preparing: "准备中",
  listening: "聆听中",
  thinking: "思考中",
  speaking: "回复中",
  stopping: "停止中",
  recovering: "恢复中",
  blocked: "需要处理",
  completed: "已结束",
  failed: "会话异常",
};

const MODE_LABELS: Record<string, string> = {
  ai_active: "AI 应答",
  operator_speaking: "人工接管",
  paused: "已暂停",
  muted: "已静音",
};

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
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [roleProfileId, setRoleProfileId] = useState("");
  const [voiceRouteId, setVoiceRouteId] = useState("");
  const [allowWebSearch, setAllowWebSearch] = useState(false);
  const [webSources, setWebSources] = useState<WebSource[]>([]);
  const [webDegraded, setWebDegraded] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [inputSource, setInputSource] = useState("text");
  const [meetingProcesses, setMeetingProcesses] = useState<MeetingProcess[]>([]);
  const [meetingPid, setMeetingPid] = useState("");
  const [audioOutputs, setAudioOutputs] = useState<AudioOutputDevice[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [virtualAudio, setVirtualAudio] = useState<VirtualAudioPreparation | null>(null);
  const [installingAudio, setInstallingAudio] = useState(false);
  const [audioPreparationPhase, setAudioPreparationPhase] = useState("checking");
  const [audioRetryBlocked, setAudioRetryBlocked] = useState(false);
  const [audioAttempted, setAudioAttempted] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    Promise.resolve(listen<string>("virtual_audio.preparation.v1", (phase) => {
      if (!disposed && phase in PREPARATION_PHASES) setAudioPreparationPhase(phase);
    })).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(() => {});
    return () => { disposed = true; unlisten(); };
  }, [listen]);
  async function refreshVirtualAudio() {
    try {
      const result = await api.getVirtualAudioStatus();
      if (!result.ok) { setVirtualAudio(null); setMessage(errorText(result.error)); return; }
      setVirtualAudio(result.data);
      setAudioRetryBlocked(result.data.state === "installing");
      setOutputDeviceId(result.data.renderEndpointId ?? "");
    } catch { setVirtualAudio(null); setMessage("无法检测虚拟声卡。"); }
  }
  async function installVirtualAudio() {
    if (installingAudio || audioRetryBlocked) return;
    setInstallingAudio(true); setAudioAttempted(true); setAudioPreparationPhase("checking"); setMessage("");
    try {
      const result = await api.installVirtualAudio();
      if (!result.ok) {
        setAudioRetryBlocked(["PREREQUISITE_TIMEOUT", "PREREQUISITE_INSTALL_BUSY"].includes(result.error.code));
        setMessage(result.error.message);
        return;
      }
      setVirtualAudio(result.data); setOutputDeviceId(result.data.renderEndpointId ?? "");
      setAudioRetryBlocked(result.data.diagnostic?.retryAllowed === false);
      setMessage(result.data.detail);
    } catch { setMessage("虚拟声卡安装失败，请稍后重试。"); }
    finally { setInstallingAudio(false); }
  }
  async function refreshAudioOutputs() {
    setOutputDeviceId("");
    try {
      const result = await api.listAudioOutputs();
      if (result.ok) setAudioOutputs(result.data);
      else { setAudioOutputs([]); setMessage(errorText(result.error)); }
    } catch { setAudioOutputs([]); setMessage("无法读取音频输出设备。"); }
  }
  async function refreshMeetings() {
    setMeetingPid("");
    try {
      const result = await api.listMeetingProcesses();
      if (!result.ok) { setMeetingProcesses([]); setMessage(result.error.message); return; }
      setMeetingProcesses(result.data);
      setMeetingPid(result.data.length === 1 ? String(result.data[0].pid) : "");
      if (!result.data.length) setMessage("未检测到会议窗口，请打开 Teams、腾讯会议、飞书、钉钉或 Zoom 后刷新。");
    } catch { setMeetingProcesses([]); setMessage("无法检测会议进程，请稍后重试。"); }
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getConfigPublic();
        if (!cancelled && result.ok) {
          setConfig(result.data);
          setRoleProfileId(result.data.activeRoleProfileId ?? "");
          setVoiceRouteId(result.data.speech.activeVoiceRouteId ?? "");
          setAllowWebSearch(roleScenario(result.data, result.data.activeRoleProfileId ?? "") === "meetingAssistant");
        }
      } catch { /* The runtime preflight supplies actionable configuration errors. */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [utterance, setUtterance] = useState("");
  const [sayText, setSayText] = useState("");
  const [correctText, setCorrectText] = useState("");
  const [revision, setRevision] = useState(0);
  const [reportSummary, setReportSummary] = useState("");
  const [reportDetail, setReportDetail] = useState("");
  const [transport, setTransport] = useState<"direct" | "livekit">("direct");
  const [livekitState, setLivekitState] = useState("idle");
  const livekitRoom = useRef<Awaited<ReturnType<typeof connectLiveKitRoom>> | null>(null);
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
    setRevision(next.revision);
    if (next.mode !== "ai_active") {
      setPendingConfirmation(false);
    }
    if (next.lastErrorCode) {
      setMessage(errorText({ code: next.lastErrorCode, message: "会话运行时错误" }));
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
              setWebSources(last.webSources ?? []);
              setWebDegraded(last.webDegraded ?? false);
              const pending = last.playbackStatus === "pending_confirmation" && last.userConfirmed !== true
                && (!statusResult.ok || statusResult.data.mode === "ai_active");
              setPendingConfirmation(pending);
              if (pending) setConfirmationText(last.assistantText);
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
    setIssues([]);
    if (config && (!roleProfileId || !voiceRouteId)) {
      setIssues([
        ...(!roleProfileId ? [{ code: "SESSION_ROLE_REQUIRED", area: "role", action: "open_services" }] : []),
        ...(!voiceRouteId ? [{ code: "SESSION_ROUTE_REQUIRED", area: "speech", action: "open_services" }] : []),
      ]);
      setMessage("");
      setBusy(false);
      return;
    }
    try {
      if (inputSource === "meeting" && !meetingPid) { setMessage("请刷新并选择会议进程。"); return; }
      if (inputSource === "meeting" && !virtualAudio?.installed) { setMessage(virtualAudio?.rebootRequired ? "请重启 Windows，使虚拟声卡生效后再开始会议。" : "请先安装并自动配置虚拟声卡。"); return; }
      const result = roleProfileId && voiceRouteId
        ? await api.startSession(transport, { roleProfileId, voiceRouteId, allowWebSearch: allowWebSearch && canSearch, ...(inputSource === "meeting" ? { meetingPid: Number(meetingPid) } : {}), ...(outputDeviceId ? { outputDeviceId } : {}) })
        : await api.startSession(transport);
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      if (result.data.kind === "blocked") {
        setIssues(result.data.issues);
        setMessage("");
        return;
      }
      setSessionId(result.data.session.id);
      sessionIdRef.current = result.data.session.id;
      setPhase(result.data.session.status);
      setTranscript("");
      setReply("");
      setWebSources([]);
      setWebDegraded(false);
      setPendingConfirmation(false);
      setConfirmationText("");
      setUnusedMaterials(false);
      setUtterance("");
      setSayText("");
      setCorrectText("");
      setReportSummary("");
      setReportDetail("");
      setMessage("");
      setLivekitState("idle");
      if (result.data.livekit) {
        try {
          livekitRoom.current = await connectLiveKitRoom(result.data.livekit);
          setLivekitState("connected");
        } catch {
          setLivekitState("error");
          setMessage("LIVEKIT_CONNECT_FAILED：无法进入房间");
        }
      }
      await refresh(result.data.session.id);
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await disconnectLiveKitRoom(livekitRoom.current);
    livekitRoom.current = null;
    setLivekitState("idle");
    const ok = await run(() => api.stopSession());
    if (ok) {
      setPendingConfirmation(false);
      await refresh();
    }
  }

  async function setModeName(next: "ai_active" | "operator_speaking" | "paused" | "muted") {
    const ok = await run(() => api.setSessionMode(next));
    if (ok) {
      setMode(next);
      if (next !== "ai_active") setPendingConfirmation(false);
      await refresh();
    }
  }

  function commandId() {
    return crypto.randomUUID();
  }

  function reportLines(result: Record<string, unknown>) {
    const report = result.report;
    if (!report || typeof report !== "object") return "";
    const parts: string[] = [];
    const record = report as Record<string, unknown>;
    for (const key of ["strengths", "followUps", "limitations"] as const) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) parts.push(item);
        }
      }
    }
    return parts.join("；");
  }

  async function runAgentCommand(input: AgentCommandInput) {
    setBusy(true);
    try {
      const result = await api.sessionAgentCommand(input);
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      if (!result.data.ok) {
        setMessage(result.data.error);
        return;
      }
      setMessage("");
      if (input.action === "report") {
        const summary =
          typeof result.data.result.summary === "string" ? result.data.result.summary : "";
        setReportSummary(summary);
        setReportDetail(reportLines(result.data.result));
      }
      await refresh();
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitSay(event: FormEvent) {
    event.preventDefault();
    await runAgentCommand({
      id: commandId(),
      action: "say",
      text: sayText.trim() || null,
      answer: null,
      mode: null,
      expectedRevision: revision,
    });
  }

  async function confirmCandidateAnswer(event: FormEvent) {
    event.preventDefault();
    const text = confirmationText.trim();
    if (!text) return;
    await runAgentCommand({
      id: commandId(),
      action: "confirm_candidate",
      text,
      answer: null,
      mode: null,
      expectedRevision: revision,
    });
  }

  async function submitCorrect() {
    await runAgentCommand({
      id: commandId(),
      action: "correct",
      text: null,
      answer: correctText.trim() || null,
      mode: null,
      expectedRevision: revision,
    });
  }

  async function submitRetry() {
    await runAgentCommand({
      id: commandId(),
      action: "retry",
      text: null,
      answer: null,
      mode: null,
      expectedRevision: revision,
    });
  }

  async function submitReport() {
    await runAgentCommand({
      id: commandId(),
      action: "report",
      text: null,
      answer: null,
      mode: null,
      expectedRevision: revision,
    });
  }

  async function submitFinalize(event: FormEvent) {
    event.preventDefault();
    if (!ACTIVE_PHASES.has(phase)) {
      setMessage("还没有开始会话，请先点开始");
      return;
    }
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
  const selectedRoleScenario = roleScenario(config, roleProfileId);
  const hotkeyInFlight = useRef(false);
  useEffect(() => {
    if (!active || inputSource !== "meeting" || selectedRoleScenario !== "meetingAssistant") return;
    let disposed = false;
    let unlisten = () => {};
    void (async () => {
      try {
        unlisten = await Promise.resolve(listen("session.assistant_hotkey.v1", () => {
          if (disposed || hotkeyInFlight.current) return;
          hotkeyInFlight.current = true;
          void api.triggerMeetingAssistant()
            .then((result) => {
              if (!result.ok) setMessage(errorText(result.error));
              else return refresh();
            })
            .catch(() => setMessage("快捷提问失败，请回到工作台重试。"))
            .finally(() => { hotkeyInFlight.current = false; });
        }));
      } catch {
        if (!disposed) setMessage("全局快捷键事件不可用；仍可在工作台点击提问。");
      }
    })();
    return () => {
      disposed = true;
      unlisten();
    };
  }, [active, inputSource, selectedRoleScenario, refresh, listen]);
  const audioFinalizePending = useRef(false);
  useEffect(() => {
    if (!active || inputSource !== "meeting" || phase !== "listening" || busy) return;
    if (!new Set<RoleScenario>(["interviewer", "hr", "candidate", "meetingAssistant"]).has(selectedRoleScenario as RoleScenario)) return;
    const timer = window.setInterval(() => {
      if (audioFinalizePending.current) return;
      void (async () => {
        try {
          const ready = await api.isSessionAudioReady();
          if (!ready.ok || !ready.data.ready || audioFinalizePending.current) return;
          audioFinalizePending.current = true;
          await finalizeUtterance("");
          await refresh();
        } catch { setMessage("自动转写失败，已保留会话，可重试或人工接管。"); }
        finally { audioFinalizePending.current = false; }
      })();
    }, 250);
    return () => window.clearInterval(timer);
  }, [active, inputSource, phase, busy, selectedRoleScenario, finalizeUtterance, refresh]);
  const selectedRoute = config?.speech.voiceRoutes.find((route) => route.id === voiceRouteId);
  const searchProtocol = config?.models.providers.find((provider) => provider.id === selectedRoute?.llmProviderId)?.webCapability;
  const canSearch = selectedRoute?.mode === "cascaded" && !!searchProtocol && searchProtocol !== "none";

  return (
    <section className="workspace-session" aria-labelledby="workspace-session-heading">
      <header className="session-toolbar">
        <div className="session-toolbar-meta">
          <h2 id="workspace-session-heading">当前会话</h2>
          <span className="status-badge" data-active={active}>
            {PHASE_LABELS[phase] ?? phase}
          </span>
          <span className="session-mode">{MODE_LABELS[mode] ?? mode}</span>
          {livekitState !== "idle" && (
            <span className="session-mode">LiveKit {livekitState === "connected" ? "已连接" : "连接失败"}</span>
          )}
        </div>
        <div className="session-toolbar-controls">
          {config && <fieldset disabled={busy || active} className="session-selection">
            <legend>本场会话配置</legend>
            <label>输入来源<select value={inputSource} onChange={(event) => { setInputSource(event.target.value); if (event.target.value === "meeting") { void refreshMeetings(); void refreshVirtualAudio(); } }}>
              <option value="text">手动文字</option><option value="meeting">会议音频</option>
            </select></label>
            {inputSource === "meeting" && <>
              <label>会议进程<select value={meetingPid} onChange={(event) => setMeetingPid(event.target.value)}>
                <option value="">请选择会议进程</option>
                {meetingProcesses.map((process) => <option key={process.pid} value={process.pid}>{MEETING_NAMES[process.name.toLowerCase()] ?? process.name} · {process.title} · {process.pid}</option>)}
              </select></label>
              <button type="button" onClick={() => void refreshMeetings()}>刷新会议进程</button>
              <small>仅采集所选会议的音频，不采集屏幕。请告知参会者 AI 参与和转写；检测停顿后自动提交完整语句。</small>
              {selectedRoleScenario === "meetingAssistant" && <small>会议助手普通讨论只转写；被点名、点击发送，或按 Ctrl+Alt+A 时才回答。</small>}
              {virtualAudio?.state === "missing" && <div className="preflight-card" role="alert">
                <span>检测到缺少虚拟声卡，是否安装并自动配置？</span>
                <button type="button" disabled={installingAudio || audioRetryBlocked} onClick={() => void installVirtualAudio()}>{installingAudio ? "正在安装…" : "是，自动安装"}</button>
              </div>}
              {installingAudio && <p role="status">{PREPARATION_PHASES[audioPreparationPhase]}… 请勿重复启动安装。</p>}
              {audioAttempted && !installingAudio && !virtualAudio?.installed && <small>最近安装步骤：{PREPARATION_PHASES[audioPreparationPhase]}。{audioRetryBlocked ? "请先重新检测，确认没有仍在运行的安装任务。" : "失败说明见页面提示；再次安装前会重新检查驱动状态。"}</small>}
              {!installingAudio && virtualAudio && !virtualAudio.installed && !["missing", "reboot_required"].includes(virtualAudio.state) && <div className="preflight-card" role="alert">{virtualAudio.detail}</div>}
              <button type="button" disabled={installingAudio} onClick={() => void refreshVirtualAudio()}>重新检测虚拟声卡</button>
              {virtualAudio?.rebootRequired && <div className="preflight-card" role="alert">虚拟声卡驱动已安装，需要重启 Windows 后继续。软件不会自动重启电脑。</div>}
              {virtualAudio?.installed && <small>虚拟声卡端点已就绪，将自动绑定音频线路；尚不代表会议对方已能听到声音。</small>}
            </>}
            {inputSource !== "meeting" && <><label>语音输出<select value={outputDeviceId} onChange={(event) => setOutputDeviceId(event.target.value)}>
              <option value="">仅文字，不播放</option>
              {audioOutputs.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select></label>
            <button type="button" onClick={() => void refreshAudioOutputs()}>刷新音频设备</button>
            <small>{outputDeviceId ? "只向所选设备播放。会议需选择虚拟声卡的输入端，并在会议软件选择对应麦克风。" : "当前仅显示文字，AI 语音不会进入会议。"}</small>
            </>}
            <label>角色<select value={roleProfileId} onChange={(event) => { const next = event.target.value; setRoleProfileId(next); setAllowWebSearch(roleScenario(config, next) === "meetingAssistant"); }}>
              <option value="">请选择角色</option>
              {config.roleProfiles.filter((role) => role.configVersion > 0).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select></label>
            <label>语音线路<select value={voiceRouteId} onChange={(event) => setVoiceRouteId(event.target.value)}>
              <option value="">请选择语音线路</option>
              {config.speech.voiceRoutes.filter((route) => route.configVersion > 0).map((route) => <option key={route.id} value={route.id}>{route.name} · {route.llmModelId ?? route.e2eModelId}</option>)}
            </select></label>
            <label><input type="checkbox" disabled={!canSearch} checked={allowWebSearch && canSearch} onChange={(event) => setAllowWebSearch(event.target.checked)} />允许本场联网搜索（可能产生费用）</label>
            {!canSearch && <small>联网问答需要级联语音线路，并在模型供应商设置中选择支持的搜索协议。</small>}
          </fieldset>}
          <fieldset className="session-transport">
            <legend>传输方式</legend>
            <label>
              <input
                type="radio"
                name="transport"
                value="direct"
                checked={transport === "direct"}
                disabled={busy || active}
                onChange={() => setTransport("direct")}
              />
              <span>本机直连</span>
            </label>
            <label>
              <input
                type="radio"
                name="transport"
                value="livekit"
                checked={transport === "livekit"}
                disabled={busy || active}
                onChange={() => setTransport("livekit")}
              />
              <span>LiveKit</span>
            </label>
          </fieldset>
          <div className="service-actions session-controls">
            <button className="button-primary" disabled={busy || active} type="button" onClick={() => void start()}>
              <Play size={14} aria-hidden="true" />开始会话
            </button>
            <button disabled={!active} type="button" onClick={() => void stop()}>
              <Square size={14} aria-hidden="true" />停止
            </button>
            <button disabled={!active} type="button" onClick={() => void setModeName("operator_speaking")}>
              <Hand size={14} aria-hidden="true" />接管
            </button>
            <button
              disabled={!active}
              type="button"
              onPointerDown={() => void setModeName("operator_speaking")}
              onPointerUp={() => void setModeName("ai_active")}
              onPointerCancel={() => void setModeName("ai_active")}
              onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") void setModeName("operator_speaking"); }}
              onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") void setModeName("ai_active"); }}
            >
              <Volume2 size={14} aria-hidden="true" />按住人工发言
            </button>
            <button disabled={busy || !active} type="button" onClick={() => void setModeName("ai_active")}>
              <Bot size={14} aria-hidden="true" />恢复 AI
            </button>
            <button disabled={busy || !active} type="button" onClick={() => void setModeName("muted")}>
              <MicOff size={14} aria-hidden="true" />静音
            </button>
          </div>
        </div>
      </header>
      <PreflightIssues issues={issues} />
      {webDegraded && <p className="services-message">联网搜索未成功，本次回答未联网，请勿作为最新信息使用。</p>}
      {webSources.length > 0 && <aside className="services-message" aria-label="联网来源">
        <span>已联网 · 来源：</span>
        {webSources.map((source) => <button key={source.url} title={source.url} type="button" onClick={() => void run(() => api.openWebSource(source.url))}>{source.title}</button>)}
      </aside>}
      {message && (
        <p className="services-message session-message" role="status">
          {message}
        </p>
      )}
      <div className="session-conversation" role="region" aria-label="当前轮对话" tabIndex={0}>
        {!transcript && !reply ? (
          <div className="session-welcome">
            <span className="session-welcome-icon"><MessageSquare size={25} strokeWidth={1.5} aria-hidden="true" /></span>
            <h3>{active ? "正在等待你的输入" : "开始一段新对话"}</h3>
            <p>{active ? "说出问题，或在下方输入语句。" : "点击「开始会话」，与 RoleAI 交流。"}</p>
          </div>
        ) : (
          <div className="session-turn">
            <p className="session-turn-label">当前轮</p>
            {transcript && (
              <article className="session-bubble session-bubble-user" aria-label="用户转写">
                <h3>你 <span>· 转写</span></h3>
                <p>{transcript}</p>
              </article>
            )}
            {reply && (
              <article className="session-bubble session-bubble-assistant" aria-label="AI 回复">
                <h3><Bot size={16} aria-hidden="true" />RoleAI</h3>
                <p>{reply}</p>
              </article>
            )}
            {pendingConfirmation && (
              <form className="candidate-confirmation" onSubmit={confirmCandidateAnswer}>
                <label htmlFor="candidate-confirmation-text">确认播报内容</label>
                <textarea
                  id="candidate-confirmation-text"
                  value={confirmationText}
                  onChange={(event) => setConfirmationText(event.target.value)}
                />
                <p>求职者模式不会自动播报。请核对或编辑后再确认。</p>
                <button className="button-primary" disabled={busy || !active || !confirmationText.trim()} type="submit">
                  <Volume2 size={15} aria-hidden="true" />确认并播报
                </button>
              </form>
            )}
          </div>
        )}
        {unusedMaterials && <p className="session-materials-note">本轮未使用资料</p>}
      </div>
      <form className="session-compose" onSubmit={submitFinalize}>
        <label htmlFor="session-utterance">语句输入</label>
        <div className="session-compose-row">
          <input
            id="session-utterance"
            value={utterance}
            placeholder={active ? "输入你想说的话…" : "开始会话后发送语句…"}
            onChange={(event) => setUtterance(event.target.value)}
          />
          <button className="button-primary" disabled={busy || !active} type="submit">
            <ArrowUp size={16} aria-hidden="true" />发送
          </button>
        </div>
      </form>
      <details className="session-tools">
        <summary><Wrench size={15} aria-hidden="true" />会话工具<ChevronDown size={15} className="session-tools-chevron" aria-hidden="true" /></summary>
        <div className="session-tools-body" role="region" aria-label="会话工具">
          <form className="service-form session-tool-form" onSubmit={submitSay}>
            <label htmlFor="session-say">朗读文本</label>
            <div className="session-tool-row">
              <input id="session-say" value={sayText} onChange={(event) => setSayText(event.target.value)} placeholder="输入需要 AI 朗读的文本" />
              <button disabled={busy || !active} type="submit"><Volume2 size={15} aria-hidden="true" />朗读</button>
            </div>
          </form>
          <form className="service-form session-tool-form" onSubmit={(event) => { event.preventDefault(); void submitCorrect(); }}>
            <label htmlFor="session-correct">纠正内容</label>
            <div className="session-tool-row">
              <input id="session-correct" value={correctText} onChange={(event) => setCorrectText(event.target.value)} placeholder="输入修正后的回答" />
              <button disabled={busy || !active} type="submit">纠正</button>
            </div>
          </form>
          <div className="service-actions">
            <button disabled={busy || !active} type="button" onClick={() => void submitRetry()}><RotateCcw size={15} aria-hidden="true" />重试</button>
            <button disabled={busy || !active} type="button" onClick={() => void submitReport()}><FileText size={15} aria-hidden="true" />报告</button>
          </div>
          {(reportSummary || reportDetail) && (
            <section className="session-report" aria-labelledby="session-report-heading">
              <h3 id="session-report-heading">会话纪要</h3>
              {reportSummary && <p>{reportSummary}</p>}
              {reportDetail && <p className="muted">{reportDetail}</p>}
            </section>
          )}
        </div>
      </details>
    </section>
  );
}
