"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadRemoteMonitorEnabled,
  saveRemoteMonitorEnabled,
  subscribeRemoteMonitor
} from "../audio/remote-monitor";
import {
  loadLocalAiMonitorEnabled,
  saveLocalAiMonitorEnabled,
  subscribeLocalAiMonitor
} from "../audio/local-ai-monitor";
import {
  loadAiReferenceModeEnabled,
  saveAiReferenceModeEnabled,
  subscribeAiReferenceMode
} from "../audio/ai-reference-mode";
import {
  beginIntervention,
  emergencyMute,
  endIntervention,
  initialInterventionState,
  resumeAi
} from "./intervention-state";
import { startHumanMicrophoneBridge, type HumanMicrophoneBridge } from "../audio/human-microphone-bridge";
import { sendAgentCommand } from "../rtc/bridge-session";

export function InterventionControls({ onAiPauseChange }: { onAiPauseChange(paused: boolean): void }) {
  const [state, setState] = useState(initialInterventionState);
  const [remoteMonitor, setRemoteMonitor] = useState(true);
  const [localAiMonitor, setLocalAiMonitor] = useState(true);
  const [aiReferenceMode, setAiReferenceMode] = useState(false);
  const [interventionMessage, setInterventionMessage] = useState("");
  const [localMonitorMessage, setLocalMonitorMessage] = useState("");
  const [audioRouteState, setAudioRouteState] = useState({
    virtual: "stopped",
    monitor: "stopped",
    retryable: false,
    endpointLabel: "",
    signalState: "unverified",
  });
  const [switchingIntervention, setSwitchingIntervention] = useState(false);
  const microphoneBridgeRef = useRef<HumanMicrophoneBridge | null>(null);

  useEffect(() => {
    setRemoteMonitor(loadRemoteMonitorEnabled());
    return subscribeRemoteMonitor(() => setRemoteMonitor(loadRemoteMonitorEnabled()));
  }, []);

  useEffect(() => {
    setLocalAiMonitor(loadLocalAiMonitorEnabled());
    return subscribeLocalAiMonitor(() => setLocalAiMonitor(loadLocalAiMonitorEnabled()));
  }, []);

  useEffect(() => {
    const onRouteStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ route?: string; state?: string; endpointLabel?: string; signalState?: string }>).detail;
      if (!detail?.route || !detail.state) return;
      setAudioRouteState((current) => ({
        ...current,
        [detail.route === "virtual-output" ? "virtual" : "monitor"]: detail.state,
        retryable: detail.state === "blocked" || detail.state === "failed"
          ? true
          : current.retryable,
        endpointLabel: detail.endpointLabel || current.endpointLabel,
        signalState: detail.signalState || current.signalState,
      }));
    };
    window.addEventListener("ai-audio-route-status", onRouteStatus);
    return () => window.removeEventListener("ai-audio-route-status", onRouteStatus);
  }, []);

  useEffect(() => {
    setAiReferenceMode(loadAiReferenceModeEnabled());
    return subscribeAiReferenceMode(() => setAiReferenceMode(loadAiReferenceModeEnabled()));
  }, []);

  useEffect(() => () => microphoneBridgeRef.current?.stop(), []);

  useEffect(() => {
    const onPlaybackError = () => {
      setLocalMonitorMessage("本机 AI 声音播放失败；请关闭再开启“本机听到 AI 播报”重试。");
    };
    window.addEventListener("ai-local-monitor-error", onPlaybackError);
    return () => window.removeEventListener("ai-local-monitor-error", onPlaybackError);
  }, []);

  async function setAgentMode(mode: "ai-active" | "operator-speaking" | "paused" | "muted") {
    return sendAgentCommand({
      id: crypto.randomUUID(),
      action: "set_mode",
      mode,
      expectedRevision: 0,
    });
  }

  async function toggleHumanSpeech() {
    if (switchingIntervention) return;
    setSwitchingIntervention(true);
    setInterventionMessage("");
    if (state.humanMicActive) {
      microphoneBridgeRef.current?.stop();
      microphoneBridgeRef.current = null;
      setState((current) => endIntervention(current));
      onAiPauseChange(true);
      window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "end" } }));
      try {
        await setAgentMode("paused");
        setInterventionMessage("人工说话已关闭，AI 保持暂停；点击“恢复 AI”后才会继续自动回答。");
      } catch (cause) {
        setInterventionMessage(cause instanceof Error ? cause.message : "Agent 暂停状态同步失败");
      } finally {
        setSwitchingIntervention(false);
      }
      return;
    }

    onAiPauseChange(true);
    window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "begin" } }));
    try {
      await setAgentMode("operator-speaking");
      const bridge = await startHumanMicrophoneBridge();
      microphoneBridgeRef.current = bridge;
      setState((current) => beginIntervention(current));
      setInterventionMessage(`人工说话中：系统默认麦克风正发送到“${bridge.outputLabel}”，AI 不会回答本机声音。`);
    } catch (cause) {
      microphoneBridgeRef.current?.stop();
      microphoneBridgeRef.current = null;
      setState((current) => endIntervention(beginIntervention(current)));
      await setAgentMode("paused").catch(() => undefined);
      const code = cause instanceof Error ? cause.message : "HUMAN_MICROPHONE_BRIDGE_FAILED";
      setInterventionMessage(code === "VIRTUAL_AUDIO_ROUTE_NOT_READY"
        ? "人工说话未接通：请先在设置页完成 VB-CABLE 线路检测。AI 已保持暂停。"
        : `人工说话未接通：${code}。AI 已保持暂停。`);
    } finally {
      setSwitchingIntervention(false);
    }
  }

  return (
    <article className="card interventionControls">
      <div className="cardHeading">
        <h2>监听与人工介入</h2>
        <span className={`pill ${state.humanMicActive || state.aiPaused ? "" : "running"}`}>
          {state.humanMicActive
            ? "人工说话中"
            : state.aiPaused
              ? "AI 已暂停"
              : aiReferenceMode
                ? "AI 参考模式"
                : "AI 自动模式"}
        </span>
      </div>
      {interventionMessage ? <p className="muted" aria-live="polite">{interventionMessage}</p> : null}
      <button
        type="button"
        className="toggleRow"
        role="switch"
        aria-checked={remoteMonitor}
        onClick={() => {
          const enabled = !remoteMonitor;
          setRemoteMonitor(enabled);
          saveRemoteMonitorEnabled(enabled);
        }}
      >
        <span>本机听到对方说话</span>
        <span className={`switch ${remoteMonitor ? "switchOn" : ""}`} aria-hidden />
      </button>
      <button
        type="button"
        className="toggleRow"
        role="switch"
        aria-checked={aiReferenceMode}
        onClick={() => {
          const enabled = !aiReferenceMode;
          setAiReferenceMode(enabled);
          saveAiReferenceModeEnabled(enabled);
        }}
      >
        <span>AI 参考模式（只显示答案，不播报）</span>
        <span className={`switch ${aiReferenceMode ? "switchOn" : ""}`} aria-hidden />
      </button>
      <button
        type="button"
        className="toggleRow"
        role="switch"
        aria-checked={localAiMonitor}
        onClick={() => {
          const enabled = !localAiMonitor;
          setLocalAiMonitor(enabled);
          setLocalMonitorMessage("");
          saveLocalAiMonitorEnabled(enabled);
        }}
      >
        <span>本机听到 AI 播报</span>
        <span className={`switch ${localAiMonitor ? "switchOn" : ""}`} aria-hidden />
      </button>
      {localMonitorMessage ? <p className="error" role="alert">{localMonitorMessage}</p> : null}
      <p className="muted" aria-live="polite">
        会议输出：{audioRouteState.virtual}（{audioRouteState.endpointLabel || "等待端点"}，信号 {audioRouteState.signalState}）；本机监听：{audioRouteState.monitor}。会议麦克风请选择 CABLE Output (VB-Audio Virtual Cable)。
      </p>
      {audioRouteState.retryable ? (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setLocalMonitorMessage("");
            setAudioRouteState((current) => ({ ...current, retryable: false }));
            window.dispatchEvent(new CustomEvent("ai-audio-retry-request"));
          }}
        >
          重新启用 AI 声音
        </button>
      ) : null}
      <div className="obsActions">
        <button
          type="button"
          className="primary"
          disabled={state.muted || switchingIntervention}
          onClick={() => void toggleHumanSpeech()}
        >
          {state.humanMicActive ? "关闭人工说话" : "启用人工说话"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!state.aiPaused || state.humanMicActive}
          onClick={() => {
            setSwitchingIntervention(true);
            void setAgentMode("ai-active")
              .then(() => {
                setState((current) => resumeAi(current));
                onAiPauseChange(false);
                setInterventionMessage("AI 自动回答已恢复。");
                window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "resume" } }));
              })
              .catch((cause) => setInterventionMessage(cause instanceof Error ? cause.message : "恢复 AI 失败"))
              .finally(() => setSwitchingIntervention(false));
          }}
        >
          恢复 AI
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            microphoneBridgeRef.current?.stop();
            microphoneBridgeRef.current = null;
            setState((current) => emergencyMute(current));
            onAiPauseChange(true);
            window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "mute" } }));
            void setAgentMode("muted").catch((cause) => {
              setInterventionMessage(cause instanceof Error ? cause.message : "Agent 静音状态同步失败");
            });
          }}
        >
          立即静音全部输出
        </button>
      </div>
    </article>
  );
}
