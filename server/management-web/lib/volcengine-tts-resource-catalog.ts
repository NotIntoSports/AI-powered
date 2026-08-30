export type VolcengineTtsResource = {
  id: string;
  name: string;
  product: string;
  billing: string;
  notes?: string;
};

/** Official OpenSpeech X-Api-Resource-Id values for TTS / voice clone (Volcengine docs). */
export const VOLCENGINE_TTS_RESOURCES: VolcengineTtsResource[] = [
  {
    id: "seed-icl-2.0",
    name: "声音复刻 ICL 2.0",
    product: "豆包声音复刻大模型",
    billing: "声音复刻 2.0 字符版",
    notes: "S_* 复刻音色默认；项目当前默认值。"
  },
  {
    id: "seed-icl-1.0",
    name: "声音复刻 ICL 1.0",
    product: "豆包声音复刻大模型",
    billing: "声音复刻 1.0 字符版"
  },
  {
    id: "seed-icl-1.0-concurr",
    name: "声音复刻 ICL 1.0 并发版",
    product: "豆包声音复刻大模型",
    billing: "声音复刻 1.0 并发版"
  },
  {
    id: "seed-tts-2.0",
    name: "语音合成 2.0",
    product: "豆包语音合成大模型",
    billing: "语音合成 2.0 字符版",
    notes: "仅支持 2.0 预置音色（如 *_uranus_bigtts）。"
  },
  {
    id: "seed-tts-1.0",
    name: "语音合成 1.0",
    product: "豆包语音合成大模型",
    billing: "语音合成 1.0 字符版"
  },
  {
    id: "seed-tts-1.0-concurr",
    name: "语音合成 1.0 并发版",
    product: "豆包语音合成大模型",
    billing: "语音合成 1.0 并发版"
  }
];

export function findVolcengineTtsResource(id: string) {
  return VOLCENGINE_TTS_RESOURCES.find((resource) => resource.id === id);
}
