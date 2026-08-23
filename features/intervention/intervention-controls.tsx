"use client";

import { useEffect, useState } from "react";
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
  emergencyMute,
  initialInterventionState,
  resumeAi,
  toggleIntervention
} from "./intervention-state";

export function InterventionControls({ onAiPauseChange }: { onAiPauseChange(paused: boolean): void }) {
  const [state, setState] = useState(initialInterventionState);
  const [remoteMonitor, setRemoteMonitor] = useState(true);
  const [localAiMonitor, setLocalAiMonitor] = useState(true);
  const [aiReferenceMode, setAiReferenceMode] = useState(false);

  useEffect(() => {
    setRemoteMonitor(loadRemoteMonitorEnabled());
    return subscribeRemoteMonitor(() => setRemoteMonitor(loadRemoteMonitorEnabled()));
  }, []);

  useEffect(() => {
    setLocalAiMonitor(loadLocalAiMonitorEnabled());
    return subscribeLocalAiMonitor(() => setLocalAiMonitor(loadLocalAiMonitorEnabled()));
  }, []);

  useEffect(() => {
    setAiReferenceMode(loadAiReferenceModeEnabled());
    return subscribeAiReferenceMode(() => setAiReferenceMode(loadAiReferenceModeEnabled()));
  }, []);

  function toggleHumanSpeech() {
    const enabling = !state.humanMicActive;
    setState((current) => toggleIntervention(current));
    if (enabling) onAiPauseChange(true);
    window.dispatchEvent(new CustomEvent("ai-intervention", {
      detail: { action: enabling ? "begin" : "end" }
    }));
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
          saveLocalAiMonitorEnabled(enabled);
        }}
      >
        <span>本机听到 AI 播报</span>
        <span className={`switch ${localAiMonitor ? "switchOn" : ""}`} aria-hidden />
      </button>
      <div className="obsActions">
        <button
          type="button"
          className="primary"
          disabled={state.muted}
          onClick={toggleHumanSpeech}
        >
          {state.humanMicActive ? "关闭人工说话" : "启用人工说话"}
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
