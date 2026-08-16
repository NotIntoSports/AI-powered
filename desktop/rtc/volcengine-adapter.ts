import { mapVolcengineSubtitles } from "../../lib/subtitles/map-volcengine.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleConnectConfig, SubtitleTransport } from "../../lib/subtitles/transport.ts";

type RtcEnginePort = {
  on(name: string, listener: (event: unknown) => void): unknown;
  joinRoom(token: string, roomId: string, user: { userId: string }): Promise<void>;
  setAudioSourceType(index: number, type: number): Promise<void>;
  setExternalAudioTrack(index: number, track: unknown): Promise<void>;
  publishStream(mediaType: number): Promise<void>;
  startSubtitle(config: { mode: number; targetLanguage?: string }): Promise<void>;
  stopSubtitle(): void;
  leaveRoom(): unknown;
};

export class VolcengineRtcAdapter implements SubtitleTransport {
  readonly provider = "volcengine" as const;
  private readonly engine: RtcEnginePort;
  private readonly sink: SubtitleSink;
  private sessionId = "";
  private language = "zh";
  private readonly onSubtitle = (payload: unknown) => {
    for (const event of mapVolcengineSubtitles(payload, this.sessionId, this.language)) {
      this.sink.publish(event);
    }
  };

  constructor(engine: RtcEnginePort, sink: SubtitleSink) {
    this.engine = engine;
    this.sink = sink;
  }

  async connect(config: SubtitleConnectConfig): Promise<void> {
    this.sessionId = config.sessionId;
    this.language = config.language;
    this.engine.on("onSubtitleMessageReceived", this.onSubtitle);
    await this.engine.setAudioSourceType(0, 0);
    await this.engine.setExternalAudioTrack(0, config.track);
    await this.engine.joinRoom(config.token, config.roomId, { userId: config.userId });
    await this.engine.publishStream(1);
    await this.engine.startSubtitle({ mode: 0, targetLanguage: config.language });
  }

  async disconnect(): Promise<void> {
    this.engine.stopSubtitle();
    await this.engine.leaveRoom();
  }
}
