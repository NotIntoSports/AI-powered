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
        <span className={state.humanMicActive ? "ready" : ""}>
          {state.humanMicActive ? "人工说话中" : state.aiPaused ? "AI 已暂停" : "AI 自动模式"}
        </span>
      </div>
      <label className="autoFollowup">
        <input
          type="checkbox"
          checked={remoteMonitor}
          onChange={(event) => {
            const enabled = event.target.checked;
            setRemoteMonitor(enabled);
            saveRemoteMonitorEnabled(enabled);
          }}
        />
        <span>
          <strong>本机听到对方说话</strong>
          <small>
            默认开启。听到对面后，再决定要不要按住说话打断 AI；若会议软件里已经能听见，可关掉避免双声。
          </small>
        </span>
      </label>
      <div className="obsActions">
        <button
          type="button"
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
      <p className="muted">
        按下后 AI 停止自动回应并让出声音；松开后 AI 不会自动恢复。真实麦克风只进入虚拟麦克风，不进入对方字幕。
      </p>
    </article>
  );
}
