import type { SubtitleSink } from "./sink.ts";
import type { RtcNetworkStats } from "../webrtc-stats.ts";
import type { AgentCommand, AgentCommandResult } from "../agent-command/contract.ts";

export type SubtitleProvider = "livekit";

export type SubtitleConnectConfig = {
  sessionId: string;
  language: string;
  track: unknown;
  token: string;
  roomId: string;
  userId: string;
  url?: string;
  sessionContext: {
    v: 1;
    role: string;
    topic: string;
    history: Array<{ role: string; text: string }>;
    resumeIds: string[];
  };
  onConnectionStateChange?: (
    state: "reconnecting" | "connected" | "disconnected",
    reason?: string
  ) => void;
  onAgentPresence?: (present: boolean) => void;
};

export type SubtitleTransport = {
  readonly provider: SubtitleProvider;
  connect(config: SubtitleConnectConfig): Promise<void>;
  disconnect(): Promise<void>;
  getNetworkStats?(): Promise<RtcNetworkStats | null>;
  sendAgentCommand?(command: AgentCommand): Promise<AgentCommandResult>;
};
