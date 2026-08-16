import { mapVolcengineSubtitles } from "../../lib/subtitles/map-volcengine.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleConnectConfig, SubtitleTransport } from "../../lib/subtitles/transport.ts";
import type { RtcNetworkStats } from "../../lib/webrtc-stats.ts";

type RtcEnginePort = {
  on(name: string, listener: (event: unknown) => void): unknown;
  joinRoom(token: string, roomId: string, user: { userId: string }): Promise<void>;
  setAudioSourceType(index: number, type: number): Promise<void>;
  setExternalAudioTrack(index: number, track: unknown): Promise<void>;
  publishStream(mediaType: number): Promise<void>;
  startSubtitle(config: { mode: number; targetLanguage?: string }): Promise<void>;
  stopSubtitle(): void;
  leaveRoom(): unknown;
  getStats?: () => Promise<unknown> | unknown;
};

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !(value instanceof Map)) return value as Record<string, unknown>;
  return null;
}

function parseVolcengineStats(raw: unknown): RtcNetworkStats | null {
  const record = raw instanceof Map ? Object.fromEntries(raw.entries()) : asRecord(raw);
  if (!record) return null;
  const nested = asRecord(record.localAudioStats) || asRecord(record.stats) || record;
  const rtt = numberField(nested.rtt) ?? numberField(nested.rttMs);
  const txLoss = numberField(nested.txLossRate) ?? numberField(nested.lossRate);
  const rxLoss = numberField(nested.rxLossRate);
  const loss = txLoss ?? rxLoss;
  return {
    rttMs: rtt != null ? Math.round(rtt) : null,
    packetLossPct: loss == null ? null : Math.round((loss > 1 ? loss : loss * 100) * 10) / 10,
    packetsLost: 0,
    packetsSentOrReceived: 0
  };
}

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

  async getNetworkStats(): Promise<RtcNetworkStats | null> {
    if (!this.engine.getStats) return null;
    try {
      return parseVolcengineStats(await this.engine.getStats());
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    this.engine.stopSubtitle();
    await this.engine.leaveRoom();
  }
}
