import type { SubtitleSink } from "./sink.ts";
import type { RtcNetworkStats } from "../webrtc-stats.ts";

export type SubtitleProvider = "livekit";

export type SubtitleConnectConfig = {
  sessionId: string;
  language: string;
  track: unknown;
  token: string;
  roomId: string;
  userId: string;
  url?: string;
  onConnectionStateChange?: (
    state: "reconnecting" | "connected" | "disconnected",
    reason?: string
  ) => void;
};

export type SubtitleTransport = {
  readonly provider: SubtitleProvider;
  connect(config: SubtitleConnectConfig): Promise<void>;
  disconnect(): Promise<void>;
  getNetworkStats?(): Promise<RtcNetworkStats | null>;
};
