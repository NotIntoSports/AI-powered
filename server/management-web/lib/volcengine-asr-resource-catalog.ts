export type VolcengineAsrResource = {
  id: string;
  name: string;
  product: string;
  billing: string;
  protocol: string;
  notes?: string;
};

/** Official OpenSpeech X-Api-Resource-Id values for ASR (Volcengine docs). */
export const VOLCENGINE_ASR_RESOURCES: VolcengineAsrResource[] = [
  {
    id: "volc.bigasr.auc_turbo",
    name: "录音文件极速版",
    product: "豆包语音识别 1.0",
    billing: "按量",
    protocol: "HTTP flash",
    notes: "项目当前默认值；同步识别 ≤2 h / ≤100 MB。"
  },
  {
    id: "volc.bigasr.sauc.duration",
    name: "流式识别 1.0 小时版",
    product: "豆包流式语音识别 1.0",
    billing: "小时版",
    protocol: "WebSocket /api/v3/sauc/bigmodel"
  },
  {
    id: "volc.bigasr.sauc.concurrent",
    name: "流式识别 1.0 并发版",
    product: "豆包流式语音识别 1.0",
    billing: "并发版",
    protocol: "WebSocket /api/v3/sauc/bigmodel"
  },
  {
    id: "volc.seedasr.sauc.duration",
    name: "流式识别 2.0 小时版",
    product: "豆包流式语音识别 2.0",
    billing: "小时版",
    protocol: "WebSocket /api/v3/sauc/bigmodel"
  },
  {
    id: "volc.seedasr.sauc.concurrent",
    name: "流式识别 2.0 并发版",
    product: "豆包流式语音识别 2.0",
    billing: "并发版",
    protocol: "WebSocket /api/v3/sauc/bigmodel"
  }
];

export function findVolcengineAsrResource(id: string) {
  return VOLCENGINE_ASR_RESOURCES.find((resource) => resource.id === id);
}
