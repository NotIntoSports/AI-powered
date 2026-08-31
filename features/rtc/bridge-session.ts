import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import { loadRemoteMonitorEnabled, subscribeRemoteMonitor } from "../audio/remote-monitor.ts";
import { emitPipelineEvent } from "../diagnostics/pipeline-log.ts";
import { setRtcNetwork } from "./network-quality.ts";
import { subtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleProvider, SubtitleTransport } from "../../lib/subtitles/transport.ts";
import type { AgentCommand, AgentCommandResult } from "../../lib/agent-command/contract.ts";

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
  onTransportState(state: "reconnecting" | "connected" | "disconnected", reason?: string): void;
};
export type BridgeSessionHandle = { owner: BridgeSessionOwner; roomId: string; provider: SubtitleProvider };

export function getDesktopBridge(): DesktopBridge | null {
  return (window as { aiInterviewerDesktop?: DesktopBridge }).aiInterviewerDesktop || null;
}

export function providerLabel(_provider: SubtitleProvider) {
  return "LiveKit";
}

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
  transport: SubtitleTransport;
};
let active: ActiveSession | null = null;
let starting = false;

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
  if (active || starting) throw new Error("已有桥接会话正在运行，请先停止后再启动。");
  starting = true;
  try {
    const debugWeb = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("bridgeDebug") === "1";
    const bridge = getDesktopBridge();
    if (!bridge && !debugWeb) throw new Error("请在 Windows 客户端中使用音频桥接功能。");
    console.log(`[bridge] start owner=${owner} pid=${pid} mode=${bridge ? "desktop" : "web-debug"}`);
    events.onStatus("正在建立音频轨道和 LiveKit 字幕线路…");
    const sessionId = makeBridgeRoomId(roomIdPrefix);
    const userId = `bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const tokenResponse = await fetch("/api/rtc/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: sessionId, userId })
    });
    const token = await tokenResponse.json() as RtcTokenResponse;
    console.log(`[bridge] token status=${tokenResponse.status} provider=${token.provider || "livekit"} urlPresent=${Boolean(token.url)} tokenPresent=${Boolean(token.token)} roomId=${token.roomId || sessionId}`);
    if (!tokenResponse.ok) throw new Error(token.message || "LiveKit Token 获取失败");
    if (!token.token || !token.url) throw new Error("LiveKit Token 获取失败");
    const activeProvider: SubtitleProvider = "livekit";
    const language = token.language || "zh";
    const roomId = token.roomId || sessionId;
    const localSession = await fetch("/api/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null) as { assistantRole?: string; roleName?: string; transcript?: Array<{ role?: string; text?: string }>; resumeIds?: string[] } | null;
    const sessionContext = {
      v: 1 as const,
      role: String(localSession?.assistantRole || "assistant"),
      topic: String(localSession?.roleName || ""),
      history: (localSession?.transcript || []).slice(-20).map((item) => ({ role: String(item.role || "user"), text: String(item.text || "").slice(0, 4000) })),
      resumeIds: (localSession?.resumeIds || []).slice(0, 20).map(String)
    };
    void emitPipelineEvent({
      event: "bridge.token-received",
      traceId: roomId,
      fields: { httpStatus: tokenResponse.status, provider: activeProvider, status: tokenResponse.ok ? "ok" : "failed" }
    });
    const pcm = createPcmTrack(loadRemoteMonitorEnabled());
    let debugTrack: MediaStreamTrack | null = null;
    let debugAudioContext: AudioContext | null = null;
    if (!bridge) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        debugTrack = stream.getAudioTracks()[0] || null;
        console.log("[bridge] web-debug: using microphone track");
      } catch (error) {
        console.warn(`[bridge] web-debug: microphone unavailable (${error instanceof Error ? error.message : String(error)}), using silent track`);
        debugAudioContext = new AudioContext({ sampleRate: 48_000 });
        const destination = debugAudioContext.createMediaStreamDestination();
        const oscillator = debugAudioContext.createOscillator();
        const silence = debugAudioContext.createGain();
        silence.gain.value = 0;
        oscillator.connect(silence);
        silence.connect(destination);
        oscillator.start();
        debugTrack = destination.stream.getAudioTracks()[0] || null;
      }
      if (!debugTrack) throw new Error("web-debug 模式无法创建本地音轨");
    }
    const publishTrack = bridge ? pcm.track : debugTrack!;
    let stopMonitorSync: (() => void) | undefined;
    let removePcm: (() => void) | undefined;
    let removeEvent: (() => void) | undefined;
    let transport: SubtitleTransport | undefined;
    try {
      stopMonitorSync = subscribeRemoteMonitor(() => pcm.setMonitorEnabled(loadRemoteMonitorEnabled()));
      subtitleSink.reset();
      transport = await createSubtitleTransport(subtitleSink);
      console.log("[bridge] transport created provider=livekit");
      const connectStartedAt = Date.now();
      try {
        await transport.connect({
          sessionId,
          language,
          track: publishTrack,
          token: token.token,
          roomId,
          userId: token.userId || userId,
          url: token.url,
          sessionContext,
          onConnectionStateChange: (state, reason) => events.onTransportState(state, reason)
        });
      } catch (error) {
        console.error(`[bridge] transport connect failed after=${Date.now() - connectStartedAt}ms`, error);
        throw error;
      }
      console.log(`[bridge] transport connected after=${Date.now() - connectStartedAt}ms`);
      void emitPipelineEvent({
        event: "bridge.transport-connected",
        traceId: roomId,
        fields: { provider: activeProvider, durationMs: Date.now() - connectStartedAt }
      });
      if (bridge) {
        let receivedFirstPcmFrame = false;
        removePcm = bridge.onAudioPcm((data) => {
          pcm.push(data);
          if (!receivedFirstPcmFrame) {
            receivedFirstPcmFrame = true;
            void emitPipelineEvent({
              event: "bridge.pcm-first-frame",
              traceId: roomId,
              fields: { bytes: data.byteLength, pid }
            });
          }
        });
        removeEvent = bridge.onAudioEvent((event) => {
          const value = event as { type?: string; peak?: number; message?: string };
          if (value.type === "level") events.onLevel(value.peak || 0);
          if (value.type === "process-exited") events.onProcessExited();
          if (value.type === "error") events.onStatus(value.message || "音频捕获失败");
        });
        await bridge.startAudioCapture(pid);
        console.log("[bridge] audio capture started");
        void emitPipelineEvent({
          event: "bridge.capture-started",
          traceId: roomId,
          fields: { pid, owner, mode: "desktop" }
        });
      } else {
        console.log("[bridge] web-debug: skipped desktop audio capture");
      }

      const statsTimer = window.setInterval(() => {
        const stats = transport!.getNetworkStats?.();
        Promise.resolve(stats).then((value) => {
          setRtcNetwork({ connected: true, rttMs: value?.rttMs ?? null, packetLossPct: value?.packetLossPct ?? null });
        }).catch(() => undefined);
      }, 2_000);

      const handle: BridgeSessionHandle = { owner, roomId, provider: activeProvider };
      active = {
        handle,
        events,
        transport,
        cleanup: async () => {
          window.clearInterval(statsTimer);
          removePcm?.();
          removeEvent?.();
          stopMonitorSync?.();
          setRtcNetwork({ connected: false });
          await bridge?.stopAudioCapture().catch(() => undefined);
          await transport?.disconnect().catch(() => undefined);
          pcm.track.stop();
          await pcm.context.close().catch(() => undefined);
          debugTrack?.stop();
          await debugAudioContext?.close().catch(() => undefined);
          subtitleSink.reset(sessionId);
        }
      };
      console.log(`[bridge] session ready owner=${owner} roomId=${roomId} provider=livekit`);
      void emitPipelineEvent({
        event: "bridge.ready",
        traceId: roomId,
        fields: { owner, provider: activeProvider, status: "ready" }
      });
      return handle;
    } catch (error) {
      console.error("[bridge] session start failed", error);
      void emitPipelineEvent({
        event: "bridge.failed",
        traceId: sessionId,
        fields: { code: error instanceof Error ? error.name : "UNKNOWN", status: "failed" }
      });
      stopMonitorSync?.();
      removePcm?.();
      removeEvent?.();
      await transport?.disconnect().catch(() => undefined);
      pcm.track.stop();
      await pcm.context.close().catch(() => undefined);
      throw error;
    }
  } finally {
    starting = false;
  }
}

export async function sendAgentCommand(command: AgentCommand): Promise<AgentCommandResult> {
  if (!active?.transport.sendAgentCommand) throw new Error("LIVEKIT_NOT_CONNECTED");
  return active.transport.sendAgentCommand(command);
}

export async function stopBridgeSession(): Promise<void> {
  const session = active;
  if (!session) return;
  active = null;
  await session.cleanup();
}
