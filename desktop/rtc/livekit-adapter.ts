import { Room, RoomEvent, Track } from "livekit-client";
import { emitPipelineEvent } from "../../features/diagnostics/pipeline-log.ts";
import { mapAgentResponseDataPacket, AGENT_RESPONSE_DATA_TOPIC } from "../../lib/agent-response/contract.ts";
import { agentResponseSink } from "../../lib/agent-response/sink.ts";
import { SUBTITLE_DATA_TOPIC } from "../../lib/subtitles/contract.ts";
import { mapLiveKitDataPacket, mapLiveKitSegment } from "../../lib/subtitles/map-livekit.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleConnectConfig, SubtitleTransport } from "../../lib/subtitles/transport.ts";
import { summarizeRtcStats, type RtcNetworkStats } from "../../lib/webrtc-stats.ts";
import { loadVirtualAudioRoute, resolvePreferredVirtualAudioRoute } from "../../features/audio/virtual-audio-route.ts";
import { classifyAudioDevices } from "../../features/audio/audio-devices.ts";
import { loadLocalAiMonitorEnabled, subscribeLocalAiMonitor } from "../../features/audio/local-ai-monitor.ts";
import { AgentAudioPlaybackController, type AgentAudioTrackLike } from "../../features/audio/agent-audio-playback.ts";
import { AGENT_COMMAND_RESULT_TOPIC, AGENT_COMMAND_TOPIC, decodeAgentCommandResult, encodeAgentCommand, type AgentCommand, type AgentCommandResult } from "../../lib/agent-command/contract.ts";

type StatsCapableTrack = {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>;
  sender?: { getStats(): Promise<RTCStatsReport> };
  receiver?: { getStats(): Promise<RTCStatsReport> };
};

async function statsFromTrack(track: StatsCapableTrack | undefined) {
  if (!track) return null;
  if (track.getRTCStatsReport) {
    const report = await track.getRTCStatsReport();
    return report || null;
  }
  if (track.sender?.getStats) return track.sender.getStats();
  if (track.receiver?.getStats) return track.receiver.getStats();
  return null;
}

export class LiveKitRtcAdapter implements SubtitleTransport {
  readonly provider = "livekit" as const;
  private readonly sink: SubtitleSink;
  private room: Room | null = null;
  private sessionId = "";
  private readonly agentAudio: AgentAudioPlaybackController;
  private stopLocalAiMonitorSync: (() => void) | null = null;
  private stopAudioRetrySync: (() => void) | null = null;
  private pendingCommands = new Map<string, { resolve: (result: AgentCommandResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(sink: SubtitleSink) {
    this.sink = sink;
    this.agentAudio = new AgentAudioPlaybackController({
      resolveVirtualOutputDeviceId: async (attempt = 0) => {
        const route = loadVirtualAudioRoute();
        const devices = await navigator.mediaDevices.enumerateDevices();
        const candidates = devices.map((device) => ({
          kind: device.kind as "audioinput" | "audiooutput",
          label: device.label,
          deviceId: device.deviceId,
        }));
        const preferred = route
          ? resolvePreferredVirtualAudioRoute(route, candidates)
          : classifyAudioDevices(candidates).routes[0] || null;
        const fallback = attempt === 1
          ? candidates.find((device) => device.kind === "audiooutput" && /\bcable\s+in\s+16ch\b/i.test(device.label))
          : null;
        const resolved = fallback && preferred ? { ...preferred, output: fallback.label, outputDeviceId: fallback.deviceId || "" } : preferred;
        if (!resolved?.outputDeviceId) throw new Error("VIRTUAL_AUDIO_ROUTE_NOT_READY");
        return { deviceId: resolved.outputDeviceId, endpointLabel: resolved.output, inputDeviceId: resolved.inputDeviceId };
      },
      verifyVirtualSignal: async (route) => {
        if (!route.inputDeviceId) return "unverified";
        let stream: MediaStream | null = null;
        let context: AudioContext | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: route.inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
          context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          context.createMediaStreamSource(stream).connect(analyser);
          await context.resume();
          const samples = new Uint8Array(analyser.fftSize);
          const deadline = performance.now() + 1_600;
          let peak = 0;
          while (performance.now() < deadline) {
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
            peak = Math.max(peak, Math.sqrt(sum / samples.length));
            if (peak >= 0.012) return "detected";
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return "missing";
        } catch {
          return "unverified";
        } finally {
          stream?.getTracks().forEach((track) => track.stop());
          await context?.close().catch(() => undefined);
        }
      },
      startRoomAudio: async () => {
        const room = this.room;
        if (room) await room.startAudio();
      },
      onStatus: (status) => {
        console.log(`[livekit] agent audio route track=${status.trackId} route=${status.route} state=${status.state} endpoint=${status.endpointLabel || "none"} signal=${status.signalState || "none"} code=${status.code || "none"}`);
        window.dispatchEvent(new CustomEvent("ai-audio-route-status", { detail: status }));
        if (status.route === "local-monitor" && (status.state === "failed" || status.state === "blocked")) {
          window.dispatchEvent(new CustomEvent("ai-local-monitor-error", { detail: { code: status.code || "PLAYBACK_FAILED" } }));
        }
      },
    });
  }

  async connect(config: SubtitleConnectConfig): Promise<void> {
    if (!config.url) throw new Error("LIVEKIT_URL_MISSING");
    this.sessionId = config.sessionId;
    console.log(`[livekit] connecting url=${config.url} roomId=${config.roomId} userId=${config.userId} tokenPresent=${Boolean(config.token)}`);
    // LiveKit server 1.9.6 serves ws://host:7880/rtc (v0). livekit-client 2.21 defaults to
    // /rtc/v1 (singlePeerConnection); that path 404s here, and CSP used to hide the 404 so
    // the SDK never fell back. Pin dual-PC / v0 signaling to match the deployed SFU.
    const room = new Room({ singlePeerConnection: false });
    this.room = room;
    this.stopLocalAiMonitorSync?.();
    this.stopLocalAiMonitorSync = subscribeLocalAiMonitor(() => {
      void this.agentAudio.setMonitorEnabled(loadLocalAiMonitorEnabled());
    });
    this.stopAudioRetrySync?.();
    const retryAudio = () => { void this.agentAudio.retryPlayback(); };
    window.addEventListener("ai-audio-retry-request", retryAudio);
    this.stopAudioRetrySync = () => window.removeEventListener("ai-audio-retry-request", retryAudio);
    const emitAgentPresence = () => {
      let present = false;
      for (const participant of room.remoteParticipants.values()) {
        if (participant.isAgent) {
          present = true;
          break;
        }
      }
      config.onAgentPresence?.(present);
    };
    room.on(RoomEvent.ParticipantConnected, emitAgentPresence);
    room.on(RoomEvent.ParticipantDisconnected, emitAgentPresence);
    room.on(RoomEvent.Disconnected, (reason) => {
      console.warn(`[livekit] disconnected reason=${String(reason)} roomId=${this.sessionId}`);
      config.onConnectionStateChange?.("disconnected", String(reason));
      config.onAgentPresence?.(false);
    });
    room.on(RoomEvent.Reconnecting, () => {
      console.warn(`[livekit] reconnecting roomId=${this.sessionId}`);
      config.onConnectionStateChange?.("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      console.log(`[livekit] reconnected roomId=${this.sessionId}`);
      config.onConnectionStateChange?.("connected");
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) this.agentAudio.markPlaybackBlocked();
    });
    room.on(RoomEvent.TrackSubscribed, (remoteTrack) => {
      if (remoteTrack.kind !== Track.Kind.Audio) return;
      void this.agentAudio.addTrack(remoteTrack as unknown as AgentAudioTrackLike, loadLocalAiMonitorEnabled());
    });
    room.on(RoomEvent.TrackUnsubscribed, (remoteTrack) => {
      this.agentAudio.removeTrack(remoteTrack as unknown as AgentAudioTrackLike);
    });
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic === AGENT_COMMAND_RESULT_TOPIC) {
        const result = decodeAgentCommandResult(payload);
        const pending = result ? this.pendingCommands.get(result.commandId) : undefined;
        if (result && pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(result.commandId);
          result.ok ? pending.resolve(result) : pending.reject(new Error(result.error || "AGENT_COMMAND_FAILED"));
        }
        return;
      }
      if (topic === AGENT_RESPONSE_DATA_TOPIC) {
        const mapped = mapAgentResponseDataPacket(payload, this.sessionId);
        if (mapped) {
          void emitPipelineEvent({
            event: "agent-response.received",
            traceId: mapped.sessionId,
            fields: {
              final: mapped.final,
              source: mapped.source || "livekit-e2e",
              candidateLength: mapped.candidateText.length,
              replyLength: mapped.replyText.length,
              utteranceId: mapped.utteranceId
            }
          });
          agentResponseSink.publish(mapped);
        }
        return;
      }
      if (topic && topic !== SUBTITLE_DATA_TOPIC) return;
      const mapped = mapLiveKitDataPacket(payload, this.sessionId);
      if (mapped) {
        void emitPipelineEvent({
          event: "subtitle.received",
          traceId: mapped.sessionId,
          fields: {
            final: mapped.final,
            source: mapped.source || "livekit",
            textLength: mapped.text.length,
            utteranceId: mapped.utteranceId
          }
        });
        this.sink.publish(mapped);
      }
    });
    room.on(RoomEvent.TranscriptionReceived, (segments) => {
      for (const segment of segments) {
        const mapped = mapLiveKitSegment({
          id: segment.id,
          text: segment.text,
          final: segment.final,
          language: segment.language
        }, this.sessionId, config.language);
        if (mapped) {
          void emitPipelineEvent({
            event: "subtitle.received",
            traceId: mapped.sessionId,
            fields: {
              final: mapped.final,
              source: mapped.source || "livekit-transcription",
              textLength: mapped.text.length,
              utteranceId: mapped.utteranceId
            }
          });
          this.sink.publish(mapped);
        }
      }
    });
    const connectStartedAt = Date.now();
    try {
      await room.connect(config.url, config.token);
    } catch (error) {
      console.error(`[livekit] room.connect failed url=${config.url} after=${Date.now() - connectStartedAt}ms error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    console.log(`[livekit] room connected after=${Date.now() - connectStartedAt}ms state=${room.state}`);
    emitAgentPresence();
    const encodedContext = new TextEncoder().encode(JSON.stringify(config.sessionContext));
    const contextPayload = new Uint8Array(new ArrayBuffer(encodedContext.byteLength));
    contextPayload.set(encodedContext);
    await room.localParticipant.publishData(
      contextPayload,
      { reliable: true, topic: "session.context.v1" }
    );
    const mediaTrack = config.track as MediaStreamTrack;
    try {
      await room.localParticipant.publishTrack(mediaTrack, {
        name: "candidate-loopback",
        source: Track.Source.Microphone,
        dtx: false,
        red: false
      });
    } catch (error) {
      console.error(`[livekit] publishTrack failed error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    console.log("[livekit] track published name=candidate-loopback");
  }

  async getNetworkStats(): Promise<RtcNetworkStats | null> {
    const room = this.room;
    if (!room) return null;
    const reports: RTCStatsReport[] = [];
    for (const publication of room.localParticipant.audioTrackPublications.values()) {
      const report = await statsFromTrack(publication.track as StatsCapableTrack | undefined);
      if (report) reports.push(report);
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const report = await statsFromTrack(publication.track as StatsCapableTrack | undefined);
        if (report) reports.push(report);
      }
    }
    if (!reports.length) return { rttMs: null, packetLossPct: null, packetsLost: 0, packetsSentOrReceived: 0 };
    return summarizeRtcStats(reports);
  }

  async sendAgentCommand(command: AgentCommand): Promise<AgentCommandResult> {
    if (!this.room) throw new Error("LIVEKIT_NOT_CONNECTED");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingCommands.delete(command.id); reject(new Error("AGENT_COMMAND_TIMEOUT")); }, 60_000);
      this.pendingCommands.set(command.id, { resolve, reject, timer });
      this.room!.localParticipant.publishData(encodeAgentCommand(command), { reliable: true, topic: AGENT_COMMAND_TOPIC })
        .catch((error) => { clearTimeout(timer); this.pendingCommands.delete(command.id); reject(error); });
    });
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    for (const pending of this.pendingCommands.values()) { clearTimeout(pending.timer); pending.reject(new Error("LIVEKIT_DISCONNECTED")); }
    this.pendingCommands.clear();
    this.stopLocalAiMonitorSync?.();
    this.stopLocalAiMonitorSync = null;
    this.stopAudioRetrySync?.();
    this.stopAudioRetrySync = null;
    this.agentAudio.clear();
    await room?.disconnect();
  }
}
