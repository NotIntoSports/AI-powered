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

export type RtcConnectConfig = {
  token: string;
  roomId: string;
  userId: string;
  language: string;
  track: unknown;
};

export class VolcengineRtcAdapter {
  private readonly engine: RtcEnginePort;
  private readonly onSubtitle: (event: unknown) => void;

  constructor(
    engine: RtcEnginePort,
    onSubtitle: (event: unknown) => void = () => undefined
  ) {
    this.engine = engine;
    this.onSubtitle = onSubtitle;
  }

  async connect(config: RtcConnectConfig): Promise<void> {
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
