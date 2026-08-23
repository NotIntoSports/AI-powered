export type CaptureState = "off" | "capturing" | "silent";

export type StageStatus = {
  connected: boolean;
  lastSeen: number;
  ttsSupported: boolean;
  voiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
  stopSpeechAt: number;
  captureState: CaptureState;
  captureSource: string;
  captureUpdatedAt: number;
};

export type StageTestSpeech = {
  id: number;
  text: string;
  createdAt: number;
};

type StoredStageStatus = {
  lastSeen: number;
  ttsSupported: boolean;
  voiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
  captureState: CaptureState;
  captureSource: string;
  captureUpdatedAt: number;
};

const globalStatus = globalThis as typeof globalThis & {
  stageStatus?: Partial<StoredStageStatus>;
  stageTestSpeech?: StageTestSpeech;
  stageStopSpeechAt?: number;
};

export type StageStatusUpdate = {
  ttsSupported?: boolean;
  voiceCount?: number;
  ttsState?: "idle" | "speaking" | "ready" | "error";
  ttsError?: string;
  lastSpeechAt?: number;
  mediaReady?: boolean;
  captureState?: CaptureState;
  captureSource?: string;
};

// 合并式上报：主工作台刷新 TTS 与采集字段，视觉舞台只读取状态。
// lastSeen 仅由 TTS 字段上报刷新，避免采集上报把舞台误判为在线。
export function updateStageStatus(status: StageStatusUpdate) {
  const previous = globalStatus.stageStatus ?? {};
  const next: Partial<StoredStageStatus> = { ...previous, ...status };
  const touchesStage = ["ttsSupported", "voiceCount", "ttsState", "ttsError", "lastSpeechAt", "mediaReady"]
    .some((key) => key in status);
  if (touchesStage) {
    next.lastSeen = Date.now();
  }
  if (status.captureState !== undefined) {
    next.captureUpdatedAt = Date.now();
  }
  globalStatus.stageStatus = next;
}

export function getStageStatus(): StageStatus {
  const status = globalStatus.stageStatus ?? {};
  const lastSeen = status.lastSeen ?? 0;
  return {
    ttsSupported: status.ttsSupported ?? false,
    voiceCount: status.voiceCount ?? 0,
    ttsState: status.ttsState ?? "idle",
    ttsError: status.ttsError ?? "",
    lastSpeechAt: status.lastSpeechAt ?? 0,
    mediaReady: status.mediaReady ?? false,
    captureState: status.captureState ?? "off",
    captureSource: status.captureSource ?? "",
    captureUpdatedAt: status.captureUpdatedAt ?? 0,
    connected: Date.now() - lastSeen < 8_000,
    lastSeen,
    stopSpeechAt: globalStatus.stageStopSpeechAt ?? 0
  };
}

export function requestStageSpeechStop() {
  globalStatus.stageStopSpeechAt = Date.now();
  return globalStatus.stageStopSpeechAt;
}

export function queueStageTestSpeech(text: string): StageTestSpeech {
  const previousId = globalStatus.stageTestSpeech?.id ?? 0;
  const speech = {
    id: Math.max(Date.now(), previousId + 1),
    text,
    createdAt: Date.now()
  };
  globalStatus.stageTestSpeech = speech;
  return speech;
}

export function getStageTestSpeech(): StageTestSpeech | null {
  return globalStatus.stageTestSpeech ?? null;
}
