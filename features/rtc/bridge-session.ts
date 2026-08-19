import VERTC from "@volcengine/rtc";
import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import { loadRemoteMonitorEnabled, subscribeRemoteMonitor } from "../audio/remote-monitor.ts";
import { setRtcNetwork } from "./network-quality.ts";
import { subtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleProvider, SubtitleTransport } from "../../lib/subtitles/transport.ts";

export type MeetingProcess = { pid: number; name: string; title: string };
export type DesktopBridge = {
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

export type BridgeSessionOwner = "manual" | "auto";
export type BridgeSessionEvents = {
  onStatus(message: string): void;
  onLevel(peak: number): void;
  onProcessExited(): void;
};
export type BridgeSessionHandle = { owner: BridgeSessionOwner; roomId: string; provider: SubtitleProvider };

export function getDesktopBridge(): DesktopBridge | null {
  return (window as { aiInterviewerDesktop?: DesktopBridge }).aiInterviewerDesktop || null;
}

export function providerLabel(provider: SubtitleProvider) {
  return provider === "livekit" ? "自建 LiveKit" : "火山云 RTC";
}

// createPcmTrack 原样搬自 rtc-bridge-control.tsx（48kHz PCM16 → MediaStreamTrack，含监听增益）
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
    setMonitorEnabled(enabled: boolean) { monitorGain.gain.value = enabled ? 1 : 0; }
  };
}

type ActiveSession = {
  handle: BridgeSessionHandle;
  events: BridgeSessionEvents;
  cleanup: () => Promise<void>;
};
let active: ActiveSession | null = null;

export function isBridgeSessionRunning(): boolean {
  return active !== null;
}

export function getBridgeSessionHandle(): BridgeSessionHandle | null {
  return active?.handle || null;
}

export function makeBridgeRoomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}`;
}

export async function startBridgeSession(
  pid: number,
  owner: BridgeSessionOwner,
  roomIdPrefix: string,
  events: BridgeSessionEvents
): Promise<BridgeSessionHandle> {
  if (active) throw new Error("BRIDGE_SESSION_ALREADY_RUNNING");
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("请在 Windows 客户端中使用音频桥接功能。");
  events.onStatus("正在建立音频轨道和字幕线路…");
  const sessionId = makeBridgeRoomId(roomIdPrefix);
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
  const stopMonitorSync = subscribeRemoteMonitor(() => pcm.setMonitorEnabled(loadRemoteMonitorEnabled()));
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
  const removePcm = bridge.onAudioPcm(pcm.push);
  const removeEvent = bridge.onAudioEvent((event) => {
    const value = event as { type?: string; peak?: number; message?: string };
    if (value.type === "level") events.onLevel(value.peak || 0);
    if (value.type === "process-exited") events.onProcessExited();
    if (value.type === "error") events.onStatus(value.message || "音频捕获失败");
  });
  await bridge.startAudioCapture(pid);

  const statsTimer = window.setInterval(() => {
    const stats = transport.getNetworkStats?.();
    Promise.resolve(stats).then((value) => {
      setRtcNetwork({ connected: true, rttMs: value?.rttMs ?? null, packetLossPct: value?.packetLossPct ?? null });
    }).catch(() => undefined);
  }, 2_000);

  const handle: BridgeSessionHandle = { owner, roomId, provider: activeProvider };
  active = {
    handle,
    events,
    cleanup: async () => {
      window.clearInterval(statsTimer);
      removePcm();
      removeEvent();
      stopMonitorSync();
      setRtcNetwork({ connected: false });
      await bridge.stopAudioCapture().catch(() => undefined);
      await transport.disconnect().catch(() => undefined);
      if (engine) VERTC.destroyEngine(engine);
      pcm.track.stop();
      await pcm.context.close().catch(() => undefined);
      subtitleSink.reset(sessionId);
    }
  };
  return handle;
}

export async function stopBridgeSession(): Promise<void> {
  const session = active;
  if (!session) return;
  active = null;
  await session.cleanup();
}
