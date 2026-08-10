export type InterviewReadinessInput = {
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
  id: keyof InterviewReadinessInput;
  label: string;
  ready: boolean;
  required: true;
};

const labels: Record<keyof InterviewReadinessInput, string> = {
  modelConfigured: "AI 模型已配置",
  stageConnected: "数字人舞台在线",
  mediaReady: "数字人画面已加载",
  speechReady: "中文语音可播放",
  obsConnected: "OBS 已连接",
  virtualCameraActive: "OBS 虚拟摄像头已启动",
  virtualCameraVerified: "最终摄像头画面已预览确认",
  virtualAudioReady: "虚拟麦克风线路已检测",
  meetingPreviewConfirmed: "会议软件入会预览已确认"
};

export function getInterviewReadiness(
  input: InterviewReadinessInput
): { ready: boolean; items: InterviewReadinessItem[]; missing: InterviewReadinessItem[] } {
  const items = (Object.keys(labels) as Array<keyof InterviewReadinessInput>).map((id) => ({
    id,
    label: labels[id],
    ready: input[id],
    required: true as const
  }));
  const missing = items.filter((item) => !item.ready);
  return { ready: missing.length === 0, items, missing };
}
