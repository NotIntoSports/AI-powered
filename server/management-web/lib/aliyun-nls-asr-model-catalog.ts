export type AliyunNlsAsrModel = {
  id: string;
  name: string;
  scenario: string;
  sampleRate: string;
  languages: string;
  notes?: string;
};

/** Reference ASR models for LiveKit agent / Aliyun NLS configuration. */
export const ALIYUN_NLS_ASR_MODELS: AliyunNlsAsrModel[] = [
  {
    id: "",
    name: "项目默认（Realtime SpeechTranscriber）",
    scenario: "LiveKit Agent 实时字幕",
    sampleRate: "16000 Hz",
    languages: "由控制台项目模型决定",
    notes: "留空时使用智能语音交互项目绑定的默认实时识别模型。"
  },
  {
    id: "paraformer-realtime-v2",
    name: "Paraformer Realtime v2",
    scenario: "直播、会议",
    sampleRate: "任意",
    languages: "中文（含方言）、英、日、韩、德、法、俄",
    notes: "推荐；支持语义断句与高级热词。"
  },
  {
    id: "paraformer-realtime-v1",
    name: "Paraformer Realtime v1",
    scenario: "直播、会议",
    sampleRate: "16000 Hz",
    languages: "中、英、日、韩、德、法、俄"
  },
  {
    id: "paraformer-realtime-8k-v2",
    name: "Paraformer Realtime 8k v2",
    scenario: "电话客服、8 kHz 音频",
    sampleRate: "8000 Hz",
    languages: "中文",
    notes: "支持情感识别。"
  },
  {
    id: "paraformer-realtime-8k-v1",
    name: "Paraformer Realtime 8k v1",
    scenario: "电话客服、8 kHz 音频",
    sampleRate: "8000 Hz",
    languages: "中文"
  },
  {
    id: "paraformer-v2",
    name: "Paraformer v2（录音文件）",
    scenario: "离线转写",
    sampleRate: "16000 Hz 及以上",
    languages: "中、英、日、韩、德、法、俄",
    notes: "HTTP 录音文件识别，非 LiveKit 流式路径。"
  },
  {
    id: "paraformer-8k-v2",
    name: "Paraformer 8k v2（录音文件）",
    scenario: "8 kHz 离线转写",
    sampleRate: "8000 Hz",
    languages: "中文"
  }
];

export function findAliyunNlsAsrModel(id: string) {
  return ALIYUN_NLS_ASR_MODELS.find((model) => model.id === id);
}
