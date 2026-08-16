import { Room, RoomEvent, Track } from "livekit-client";
import { SUBTITLE_DATA_TOPIC } from "../../lib/subtitles/contract.ts";
import { mapLiveKitDataPacket, mapLiveKitSegment } from "../../lib/subtitles/map-livekit.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleConnectConfig, SubtitleTransport } from "../../lib/subtitles/transport.ts";

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
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic && topic !== SUBTITLE_DATA_TOPIC) return;
      const mapped = mapLiveKitDataPacket(payload, this.sessionId);
      if (mapped) this.sink.publish(mapped);
    });
    room.on(RoomEvent.TranscriptionReceived, (segments) => {
      for (const segment of segments) {
        const mapped = mapLiveKitSegment({
          id: segment.id,
          text: segment.text,
          final: segment.final,
          language: segment.language
        }, this.sessionId, config.language);
        if (mapped) this.sink.publish(mapped);
      }
    });
    await room.connect(config.url, config.token);
    const mediaTrack = config.track as MediaStreamTrack;
    await room.localParticipant.publishTrack(mediaTrack, {
      name: "candidate-loopback",
      source: Track.Source.Microphone,
      dtx: false,
      red: false
    });
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    await room?.disconnect();
  }
}
