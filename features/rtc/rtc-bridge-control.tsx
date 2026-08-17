"use client";

import { useEffect, useRef, useState } from "react";
import VERTC from "@volcengine/rtc";
import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import {
  loadRemoteMonitorEnabled,
  subscribeRemoteMonitor
} from "../audio/remote-monitor.ts";
import {
  describeNetwork,
  getNetworkQuality,
  setRtcNetwork,
  subscribeNetworkQuality
} from "./network-quality.ts";
import { subtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleProvider, SubtitleTransport } from "../../lib/subtitles/transport.ts";

type MeetingProcess = { pid: number; name: string; title: string };
type DesktopBridge = {
  listMeetingProcesses(): Promise<MeetingProcess[]>;
  startAudioCapture(pid: number): Promise<{ started: true }>;
  stopAudioCapture(): Promise<{ stopped: true }>;
  onAudioPcm(listener: (data: Uint8Array) => void): () => void;
  onAudioEvent(listener: (event: unknown) => void): () => void;
};
type RtcTokenResponse = {
  provider?: SubtitleProvider;
  token?: string;
  appId?: string;
  url?: string;
  roomId?: string;
  userId?: string;
  language?: string;
  message?: string;
};

declare global { interface Window { aiInterviewerDesktop?: DesktopBridge } }

function createPcmTrack(monitorEnabled: boolean) {
  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const monitorGain = context.createGain();
  monitorGain.gain.value = monitorEnabled ? 1 : 0;
  monitorGain.connect(context.destination);
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
    source.connect(monitorGain);
    nextStart = Math.max(nextStart, context.currentTime + 0.02);
    source.start(nextStart);
    nextStart += buffer.duration;
  };
  return {
    context,
    track: destination.stream.getAudioTracks()[0],
    push,
    setMonitorEnabled(enabled: boolean) {
      monitorGain.gain.value = enabled ? 1 : 0;
    }
  };
}

function providerLabel(provider: SubtitleProvider) {
  return provider === "livekit" ? "自建 LiveKit" : "火山云 RTC";
}

export function RtcBridgeControl() {
  const [processes, setProcesses] = useState<MeetingProcess[]>([]);
  const [pid, setPid] = useState(0);
  const [status, setStatus] = useState("请选择正在通话的会议软件进程。");
  const [running, setRunning] = useState(false);
  const [provider, setProvider] = useState<SubtitleProvider>("volcengine");
  const [network, setNetwork] = useState(getNetworkQuality);
  const cleanupRef = useRef<null | (() => Promise<void>)>(null);
  const transportRef = useRef<SubtitleTransport | null>(null);
  const monitorRef = useRef<null | ((enabled: boolean) => void)>(null);

  useEffect(() => subscribeNetworkQuality(() => setNetwork(getNetworkQuality())), []);

  useEffect(() => {
    const apply = () => monitorRef.current?.(loadRemoteMonitorEnabled());
    apply();
    return subscribeRemoteMonitor(apply);
  }, []);

  async function refresh() {
    const bridge = window.aiInterviewerDesktop;
    if (!bridge) { setStatus("请在 Windows 客户端中使用音频桥接功能。"); return; }
    const result = await bridge.listMeetingProcesses();
    setProcesses(result);
    if (!result.some((item) => item.pid === pid)) setPid(result[0]?.pid || 0);
    setStatus(result.length ? "选择进程后可启动实时字幕。" : "未发现正在通话的受支持会议软件窗口。");
  }

  useEffect(() => { void refresh(); return () => { void cleanupRef.current?.(); }; }, []);

  async function start() {
    const bridge = window.aiInterviewerDesktop;
    if (!bridge || !pid) return;
    setStatus("正在建立音频轨道和字幕线路…");
    const sessionId = `interview_${Date.now()}`;
    const userId = `bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const tokenResponse = await fetch("/api/rtc/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: sessionId, userId })
    });
    const token = await tokenResponse.json() as RtcTokenResponse;
    if (!tokenResponse.ok) throw new Error(token.message || "RTC Token 获取失败");
    const activeProvider: SubtitleProvider = token.provider === "livekit" ? "livekit" : "volcengine";
    const language = token.language || "zh";
    const roomId = token.roomId || sessionId;
    const pcm = createPcmTrack(loadRemoteMonitorEnabled());
    monitorRef.current = pcm.setMonitorEnabled;
    subtitleSink.reset();
    let engine: ReturnType<typeof VERTC.createEngine> | undefined;
    let transport: SubtitleTransport;
    if (activeProvider === "volcengine") {
      if (!token.appId || !token.token) throw new Error("RTC Token 获取失败");
      engine = VERTC.createEngine(token.appId);
      transport = await createSubtitleTransport("volcengine", subtitleSink, engine as never);
    } else {
      transport = await createSubtitleTransport("livekit", subtitleSink);
    }
    await transport.connect({
      sessionId,
      language,
      track: pcm.track,
      token: token.token || "",
      roomId,
      userId: token.userId || userId,
      appId: token.appId,
      url: token.url
    });
    transportRef.current = transport;
    const removePcm = bridge.onAudioPcm(pcm.push);
    const removeEvent = bridge.onAudioEvent((event) => {
      const value = event as { type?: string; peak?: number; message?: string };
      if (value.type === "level") setStatus(`${providerLabel(activeProvider)} 运行中 · 对方音量 ${Math.round((value.peak || 0) * 100)}%`);
      if (value.type === "process-exited") void stop();
      if (value.type === "error") setStatus(value.message || "音频捕获失败");
    });
    await bridge.startAudioCapture(pid);
    cleanupRef.current = async () => {
      removePcm();
      removeEvent();
      monitorRef.current = null;
      transportRef.current = null;
      setRtcNetwork({ connected: false });
      await bridge.stopAudioCapture().catch(() => undefined);
      await transport.disconnect().catch(() => undefined);
      if (engine) VERTC.destroyEngine(engine);
      pcm.track.stop();
      await pcm.context.close().catch(() => undefined);
      subtitleSink.reset(sessionId);
    };
    setProvider(activeProvider);
    setRunning(true);
    setStatus(
      loadRemoteMonitorEnabled()
        ? `${providerLabel(activeProvider)} 运行中；本机正在播放对方声音（可在「监听与人工介入」关闭）。`
        : `${providerLabel(activeProvider)} 运行中；本机未播放对方声音，请用会议软件收听。`
    );
  }

  useEffect(() => {
    if (!running) {
      setRtcNetwork({ connected: false });
      return;
    }
    let active = true;
    async function poll() {
      const stats = await transportRef.current?.getNetworkStats?.().catch(() => null);
      if (!active) return;
      setRtcNetwork({
        connected: true,
        rttMs: stats?.rttMs ?? null,
        packetLossPct: stats?.packetLossPct ?? null
      });
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [running]);

  async function stop() {
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    await cleanup?.();
    setRunning(false);
    setStatus("字幕和会议进程捕获已停止。");
  }

  return (
    <article className="card" id="settings-rtc-bridge">
      <div className="cardHeading"><h2>会议音频桥接</h2><span className={running ? "ready" : ""}>{running ? `${providerLabel(provider)} 运行中` : "未启动"}</span></div>
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
      <p className="networkMeter">{describeNetwork(network)}</p>
      <p className="muted">只捕获所选会议进程及其子进程；PCM 不落盘。线路由管理端 current provider 决定，一场互动中途不切换。若会议软件重启，请重新选择进程。对方声音是否本机播放由工作台「本机听到对方说话」开关控制（默认开启）。</p>
    </article>
  );
}
