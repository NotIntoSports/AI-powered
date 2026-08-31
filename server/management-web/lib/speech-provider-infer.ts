/**
 * Infer which speech line (阿里云 / 豆包) a catalog selection maps to.
 */

export type SpeechLineProvider = "aliyun" | "volcengine";

export type CatalogHint = {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  modelId?: string;
  label?: string;
};

const ALIYUN_MARKERS = [
  "speech:aliyun",
  "aliyun",
  "token-plan",
  "tokenplan",
  "dashscope",
  "nls-gateway",
  "nls.",
  "cosyvoice",
  "通义",
  "智能语音"
];

const VOLCENGINE_MARKERS = [
  "speech:volcengine",
  "volcengine",
  "volc.",
  "openspeech",
  "bytedance",
  "豆包",
  "seed-icl",
  "bigasr"
];

function haystack(hint: CatalogHint): string {
  return [hint.providerId, hint.providerName, hint.baseUrl, hint.modelId, hint.label]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matches(hay: string, markers: string[]): boolean {
  return markers.some((marker) => hay.includes(marker.toLowerCase()));
}

/** Infer speech line from a single catalog / endpoint hint. */
export function inferSpeechProviderFromCatalog(hint: CatalogHint | null | undefined): SpeechLineProvider | null {
  if (!hint) return null;
  const providerId = (hint.providerId || "").trim().toLowerCase();
  if (providerId === "speech:aliyun") return "aliyun";
  if (providerId === "speech:volcengine") return "volcengine";

  const hay = haystack(hint);
  if (!hay.trim()) return null;

  // Prefer explicit speech: / CosyVoice before generic cloud markers.
  if (matches(hay, ["speech:aliyun", "cosyvoice"])) return "aliyun";
  if (matches(hay, ["speech:volcengine"])) return "volcengine";
  if (matches(hay, ALIYUN_MARKERS)) return "aliyun";
  if (matches(hay, VOLCENGINE_MARKERS)) return "volcengine";
  return null;
}

export function inferSpeechProviderFromPipeline(input: {
  mode: "cascaded" | "e2e" | string;
  tts?: CatalogHint | null;
  e2e?: CatalogHint | null;
}): SpeechLineProvider | null {
  if (input.mode === "e2e") {
    return inferSpeechProviderFromCatalog(input.e2e || undefined);
  }
  return inferSpeechProviderFromCatalog(input.tts || undefined);
}

export function speechProviderLabel(provider: SpeechLineProvider): string {
  return provider === "aliyun" ? "阿里云" : "豆包";
}
