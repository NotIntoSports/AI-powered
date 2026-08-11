import type { TranscriptItem } from "./interview";

type PromptTranscriptItem = Pick<TranscriptItem, "role" | "text"> & {
  kind?: TranscriptItem["kind"];
};

export function serializePromptTranscript(
  transcript: PromptTranscriptItem[],
  options: {
    maxItems: number;
    maxTextCharacters: number;
    maxSerializedCharacters: number;
  }
) {
  const selected: PromptTranscriptItem[] = [];
  const candidates = transcript.slice(-options.maxItems).reverse();
  for (const item of candidates) {
    const bounded: PromptTranscriptItem = {
      role: item.role,
      ...(item.kind ? { kind: item.kind } : {}),
      text: Array.from(item.text).slice(0, options.maxTextCharacters).join("")
    };
    const next = [bounded, ...selected];
    if (JSON.stringify(next).length > options.maxSerializedCharacters) break;
    selected.unshift(bounded);
  }
  return JSON.stringify(selected);
}
