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
};

export type StageTestSpeech = {
  id: number;
  text: string;
  createdAt: number;
};

const globalStatus = globalThis as typeof globalThis & {
  stageStatus?: Omit<StageStatus, "connected" | "stopSpeechAt">;
  stageTestSpeech?: StageTestSpeech;
  stageStopSpeechAt?: number;
};

export function updateStageStatus(status: {
  ttsSupported: boolean;
  voiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
}) {
  globalStatus.stageStatus = {
    ...status,
    lastSeen: Date.now()
  };
}

export function getStageStatus(): StageStatus {
  const status = globalStatus.stageStatus ?? {
    lastSeen: 0,
    ttsSupported: false,
    voiceCount: 0,
    ttsState: "idle",
    ttsError: "",
    lastSpeechAt: 0,
    mediaReady: false
  };
  return {
    ...status,
    connected: Date.now() - status.lastSeen < 8_000,
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
