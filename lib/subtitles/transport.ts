import type { SubtitleSink } from "./sink.ts";
import type { RtcNetworkStats } from "../webrtc-stats.ts";

export type SubtitleProvider = "volcengine" | "livekit";

export type SubtitleConnectConfig = {
  sessionId: string;
  language: string;
  track: unknown;
  token: string;
  roomId: string;
  userId: string;
  appId?: string;
  url?: string;
};

export type SubtitleTransport = {
  readonly provider: SubtitleProvider;
  connect(config: SubtitleConnectConfig): Promise<void>;
  disconnect(): Promise<void>;
  getNetworkStats?(): Promise<RtcNetworkStats | null>;
};

export type SubtitleTransportFactory = (
  provider: SubtitleProvider,
  sink: SubtitleSink
) => Promise<SubtitleTransport>;
