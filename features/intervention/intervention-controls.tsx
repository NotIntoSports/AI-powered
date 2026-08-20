"use client";

import { useEffect, useState } from "react";
import {
  loadRemoteMonitorEnabled,
  saveRemoteMonitorEnabled,
  subscribeRemoteMonitor
} from "../audio/remote-monitor";
import {
  beginIntervention,
  emergencyMute,
  endIntervention,
  initialInterventionState,
  resumeAi
} from "./intervention-state";

export function InterventionControls({ onAiPauseChange }: { onAiPauseChange(paused: boolean): void }) {
  const [state, setState] = useState(initialInterventionState);
  const [remoteMonitor, setRemoteMonitor] = useState(true);

  useEffect(() => {
    setRemoteMonitor(loadRemoteMonitorEnabled());
    return subscribeRemoteMonitor(() => setRemoteMonitor(loadRemoteMonitorEnabled()));
  }, []);

  function press() {
    setState((current) => beginIntervention(current));
    onAiPauseChange(true);
    window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "begin" } }));
  }

  function release() {
    setState((current) => endIntervention(current));
    window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "end" } }));
  }

  return (
    <article className="card interventionControls">
      <div className="cardHeading">
        <h2>监听与人工介入</h2>
        <span className={`pill ${state.humanMicActive || state.aiPaused ? "" : "running"}`}>
          {state.humanMicActive ? "人工说话中" : state.aiPaused ? "AI 已暂停" : "AI 自动模式"}
        </span>
      </div>
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
      <div className="obsActions">
        <button
          type="button"
          className="primary"
          disabled={state.muted}
          onPointerDown={press}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerLeave={() => state.humanMicActive && release()}
        >
          按住说话
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!state.aiPaused || state.humanMicActive}
          onClick={() => {
            setState((current) => resumeAi(current));
            onAiPauseChange(false);
            window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "resume" } }));
          }}
        >
          恢复 AI
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            setState((current) => emergencyMute(current));
            onAiPauseChange(true);
            window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "mute" } }));
          }}
        >
          立即静音全部输出
        </button>
      </div>
    </article>
  );
}
