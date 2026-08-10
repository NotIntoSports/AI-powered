"use client";

import { useEffect, useRef, useState } from "react";
import VERTC from "@volcengine/rtc";
import { VolcengineRtcAdapter } from "../../desktop/rtc/volcengine-adapter";

type MeetingProcess = { pid: number; name: string; title: string };
type DesktopBridge = {
  listMeetingProcesses(): Promise<MeetingProcess[]>;
  startAudioCapture(pid: number): Promise<{ started: true }>;
  stopAudioCapture(): Promise<{ stopped: true }>;
  onAudioPcm(listener: (data: Uint8Array) => void): () => void;
  onAudioEvent(listener: (event: unknown) => void): () => void;
};

declare global { interface Window { aiInterviewerDesktop?: DesktopBridge } }

function createPcmTrack() {
  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  let nextStart = context.currentTime;
  const push = (bytes: Uint8Array) => {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    const buffer = context.createBuffer(1, sampleCount, 48_000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    nextStart = Math.max(nextStart, context.currentTime + 0.02);
    source.start(nextStart);
    nextStart += buffer.duration;
  };
  return { context, track: destination.stream.getAudioTracks()[0], push };
}

export function RtcBridgeControl() {
  const [processes, setProcesses] = useState<MeetingProcess[]>([]);
  const [pid, setPid] = useState(0);
  const [status, setStatus] = useState("请选择正在通话的会议软件进程。");
  const [running, setRunning] = useState(false);
  const cleanupRef = useRef<null | (() => Promise<void>)>(null);

  async function refresh() {
    const bridge = window.aiInterviewerDesktop;
    if (!bridge) { setStatus("请在 Windows 客户端中使用音频桥接功能。"); return; }
    const result = await bridge.listMeetingProcesses();
    setProcesses(result);
    if (!result.some((item) => item.pid === pid)) setPid(result[0]?.pid || 0);
    setStatus(result.length ? "选择进程后可启动火山 RTC 实时字幕。" : "未发现正在通话的受支持会议软件窗口。");
  }

  useEffect(() => { void refresh(); return () => { void cleanupRef.current?.(); }; }, []);

  async function start() {
    const bridge = window.aiInterviewerDesktop;
    if (!bridge || !pid) return;
    setStatus("正在建立音频轨道和 RTC 字幕房间…");
    const roomId = `interview_${Date.now()}`;
    const userId = `bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const tokenResponse = await fetch("/api/rtc/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, userId })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(token.message || "RTC Token 获取失败");
    const pcm = createPcmTrack();
    const engine = VERTC.createEngine(token.appId);
    const adapter = new VolcengineRtcAdapter(engine as never, (payload) => {
      const messages = Array.isArray(payload) ? payload : [];
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const value = message as { userId?: string; sequence?: number; text?: string; definite?: boolean };
        if (typeof value.sequence !== "number" || typeof value.text !== "string") continue;
        window.dispatchEvent(new CustomEvent("rtc-subtitle", { detail: {
          userId: value.userId || "candidate",
          sequence: value.sequence,
          text: value.text,
          final: value.definite === true
        } }));
      }
    });
    await adapter.connect({ token: token.token, roomId, userId, language: token.language, track: pcm.track });
    const removePcm = bridge.onAudioPcm(pcm.push);
    const removeEvent = bridge.onAudioEvent((event) => {
      const value = event as { type?: string; peak?: number; message?: string };
      if (value.type === "level") setStatus(`字幕运行中 · 候选人音量 ${Math.round((value.peak || 0) * 100)}%`);
      if (value.type === "process-exited") void stop();
      if (value.type === "error") setStatus(value.message || "音频捕获失败");
    });
    await bridge.startAudioCapture(pid);
    cleanupRef.current = async () => {
      removePcm();
      removeEvent();
      await bridge.stopAudioCapture().catch(() => undefined);
      await adapter.disconnect().catch(() => undefined);
      VERTC.destroyEngine(engine);
      pcm.track.stop();
      await pcm.context.close().catch(() => undefined);
    };
    setRunning(true);
    setStatus("字幕运行中；监听声音仍由会议软件直接播放。");
  }

  async function stop() {
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    await cleanup?.();
    setRunning(false);
    setStatus("字幕和会议进程捕获已停止。");
  }

  return (
    <article className="card">
      <div className="cardHeading"><h2>会议音频桥接</h2><span className={running ? "ready" : ""}>{running ? "字幕运行中" : "未启动"}</span></div>
      <label>会议软件进程
        <select value={pid} disabled={running} onChange={(event) => setPid(Number(event.target.value))}>
          <option value={0}>请选择</option>
          {processes.map((process) => <option key={process.pid} value={process.pid}>{process.name} · {process.title} · PID {process.pid}</option>)}
        </select>
      </label>
      <div className="obsActions">
        <button disabled={running || !pid} onClick={() => void start().catch((error) => setStatus(error instanceof Error ? error.message : "启动失败"))}>启动实时字幕</button>
        <button className="secondary" disabled={!running} onClick={() => void stop()}>停止字幕</button>
        <button className="ghost" disabled={running} onClick={() => void refresh()}>刷新进程</button>
      </div>
      <p>{status}</p>
      <p className="muted">只捕获所选会议进程及其子进程；PCM 不落盘。若会议软件重启，请重新选择进程。</p>
    </article>
  );
}
