"use client";

import { useState } from "react";
import {
  beginIntervention,
  emergencyMute,
  endIntervention,
  initialInterventionState,
  resumeAi
} from "./intervention-state";

export function InterventionControls({ onAiPauseChange }: { onAiPauseChange(paused: boolean): void }) {
  const [state, setState] = useState(initialInterventionState);

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
      <div className="cardHeading"><h2>监听与人工介入</h2><span className={state.humanMicActive ? "ready" : ""}>{state.humanMicActive ? "人工说话中" : state.aiPaused ? "AI 已暂停" : "AI 自动模式"}</span></div>
      <p>候选人声音由会议软件直接监听，不在客户端重复播放。</p>
      <div className="obsActions">
        <button
          type="button"
          disabled={state.muted}
          onPointerDown={press}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerLeave={() => state.humanMicActive && release()}
        >按住说话</button>
        <button type="button" className="secondary" disabled={!state.aiPaused || state.humanMicActive} onClick={() => {
          setState((current) => resumeAi(current));
          onAiPauseChange(false);
        }}>恢复 AI</button>
        <button type="button" className="danger" onClick={() => {
          setState((current) => emergencyMute(current));
          onAiPauseChange(true);
          window.dispatchEvent(new CustomEvent("ai-intervention", { detail: { action: "mute" } }));
        }}>立即静音全部输出</button>
      </div>
      <p className="muted">按下后 AI 停止自动追问并让出声音；松开后 AI 不会自动恢复。真实麦克风只进入虚拟麦克风，不进入候选人字幕。</p>
    </article>
  );
}
