export type CosyVoiceVoice = {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "child" | "neutral";
};

/** Official CosyVoice preset voices (NLS / CosyVoice docs). id maps to the voice parameter. */
export const COSYVOICE_VOICES: CosyVoiceVoice[] = [
  { id: "longxiaochun", name: "龙小淳", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaochun_v2", name: "龙小淳 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaochun_v3", name: "龙小淳 3.0", language: "中文（普通话）、英文", gender: "female" },
  { id: "longwan", name: "龙婉", language: "中文及中英文混合", gender: "female" },
  { id: "longwan_v2", name: "龙婉 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longwan_v3", name: "龙婉 3.0", language: "中文（普通话）、英文", gender: "female" },
  { id: "longwanjun", name: "龙婉君", language: "中文（普通话）、英文", gender: "female" },
  { id: "longwanjun_v3", name: "龙婉君 3.0", language: "中文（普通话）、英文", gender: "female" },
  { id: "longcheng", name: "龙橙", language: "中文及中英文混合", gender: "male" },
  { id: "longcheng_v2", name: "龙橙 2.0", language: "中文及中英文混合", gender: "male" },
  { id: "longhua", name: "龙华", language: "中文及中英文混合", gender: "child" },
  { id: "longhua_v2", name: "龙华 2.0", language: "中文及中英文混合", gender: "child" },
  { id: "longshu", name: "龙书", language: "中文及中英文混合", gender: "male" },
  { id: "longshu_v2", name: "龙书 2.0", language: "中文及中英文混合", gender: "male" },
  { id: "loongbella", name: "Bella 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "loongbella_v2", name: "Bella 2.0+", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaoxia", name: "龙小夏", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaoxia_v2", name: "龙小夏 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaobai", name: "龙小白", language: "中文及中英文混合", gender: "female" },
  { id: "longxiaobai_v2", name: "龙小白 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longfei_v2", name: "龙飞 2.0", language: "中文及中英文混合", gender: "male" },
  { id: "libai_v2", name: "李白 2.0", language: "中文及中英文混合", gender: "male" },
  { id: "longyue_v2", name: "龙悦 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longnan_v2", name: "龙楠 2.0", language: "中文及中英文混合", gender: "male" },
  { id: "longyumi_v2", name: "YUMI 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "longlaotie_v2", name: "龙老铁 2.0", language: "东北话", gender: "male" },
  { id: "longjiayi_v2", name: "龙嘉怡 2.0", language: "粤语", gender: "female" },
  { id: "longtao_v2", name: "龙桃 2.0", language: "粤语", gender: "female" },
  { id: "loongstella_v2", name: "Stella 2.0", language: "中文及中英文混合", gender: "female" },
  { id: "loongeva_v2", name: "Eva 2.0", language: "英式英文", gender: "female" },
  { id: "loongbrian_v2", name: "Brian 2.0", language: "英式英文", gender: "male" },
  { id: "loongabby_v2", name: "Abby 2.0", language: "美式英文", gender: "female" },
  { id: "loongandy_v2", name: "Andy 2.0", language: "美式英文", gender: "male" },
  { id: "xiaoyun", name: "小云（NLS 系统音色）", language: "中文普通话", gender: "female" }
];

export function findCosyVoiceVoice(id: string) {
  return COSYVOICE_VOICES.find((voice) => voice.id === id);
}

/** True when voice is an official CosyVoice / NLS preset (not a cloned cosyvoice-* speaker id). */
export function isCosyVoiceSystemVoice(voice: string): boolean {
  const trimmed = voice.trim();
  if (!trimmed) return false;
  return COSYVOICE_VOICES.some((entry) => entry.id === trimmed);
}
