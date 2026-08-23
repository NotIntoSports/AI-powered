import { Room, RoomEvent, Track } from "livekit-client";
import { emitPipelineEvent } from "../../features/diagnostics/pipeline-log.ts";
import { SUBTITLE_DATA_TOPIC } from "../../lib/subtitles/contract.ts";
import { mapLiveKitDataPacket, mapLiveKitSegment } from "../../lib/subtitles/map-livekit.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleConnectConfig, SubtitleTransport } from "../../lib/subtitles/transport.ts";
import { summarizeRtcStats, type RtcNetworkStats } from "../../lib/webrtc-stats.ts";

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

  constructor(sink: SubtitleSink) {
    this.sink = sink;
  }

  async connect(config: SubtitleConnectConfig): Promise<void> {
    if (!config.url) throw new Error("LIVEKIT_URL_MISSING");
    this.sessionId = config.sessionId;
    console.log(`[livekit] connecting url=${config.url} roomId=${config.roomId} userId=${config.userId} tokenPresent=${Boolean(config.token)}`);
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.Disconnected, (reason) => {
      console.warn(`[livekit] disconnected reason=${String(reason)} roomId=${this.sessionId}`);
    });
    room.on(RoomEvent.Reconnecting, () => {
      console.warn(`[livekit] reconnecting roomId=${this.sessionId}`);
    });
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
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

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    await room?.disconnect();
  }
}
