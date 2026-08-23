import type { OutputMode } from "./output-mode";

export type InterviewReadinessInput = {
  outputMode?: OutputMode;
  modelConfigured: boolean;
  stageConnected: boolean;
  mediaReady: boolean;
  speechReady: boolean;
  obsConnected: boolean;
  virtualCameraActive: boolean;
  virtualCameraVerified: boolean;
  virtualAudioReady: boolean;
  meetingPreviewConfirmed: boolean;
};

export type InterviewReadinessItem = {
  id: keyof Omit<InterviewReadinessInput, "outputMode">;
  label: string;
  ready: boolean;
  required: boolean;
};

const labels: Record<keyof Omit<InterviewReadinessInput, "outputMode">, string> = {
  modelConfigured: "AI 模型已配置",
  stageConnected: "播报引擎在线",
  mediaReady: "助手画面已加载",
  speechReady: "中文语音可播放",
  obsConnected: "OBS 已连接",
  virtualCameraActive: "OBS 虚拟摄像头已启动",
  virtualCameraVerified: "最终摄像头画面已预览确认",
  virtualAudioReady: "虚拟麦克风线路已检测",
  meetingPreviewConfirmed: "会议软件入会预览已确认"
};

const itemIds = Object.keys(labels) as Array<keyof Omit<InterviewReadinessInput, "outputMode">>;

const virtualRequiredIds = new Set<keyof Omit<InterviewReadinessInput, "outputMode">>([
  "modelConfigured",
  "stageConnected",
  "speechReady",
  "obsConnected",
  "virtualCameraActive",
  "virtualCameraVerified",
  "virtualAudioReady",
  "meetingPreviewConfirmed"
]);

export function isReadinessItemRequired(
  id: keyof Omit<InterviewReadinessInput, "outputMode">,
  mode: OutputMode = "real"
): boolean {
  if (mode === "real") return id === "modelConfigured";
  return virtualRequiredIds.has(id);
}

export function getInterviewReadiness(
  input: InterviewReadinessInput
): { ready: boolean; items: InterviewReadinessItem[]; missing: InterviewReadinessItem[] } {
  const outputMode = input.outputMode ?? "real";
  const items = itemIds.map((id) => ({
    id,
    label: labels[id],
    ready: input[id],
    required: isReadinessItemRequired(id, outputMode)
  }));
  const missing = items.filter((item) => item.required && !item.ready);
  return { ready: missing.length === 0, items, missing };
}
