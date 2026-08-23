export type VirtualTtsSinkDecision =
  | { ok: true; sinkId: string }
  | { ok: false; code: "VIRTUAL_AUDIO_ROUTE_NOT_READY" | "SET_SINK_ID_UNSUPPORTED" };

export function requireVirtualTtsSink(input: {
  sinkId: string | null;
  setSinkSupported: boolean;
}): VirtualTtsSinkDecision {
  if (!input.sinkId) return { ok: false, code: "VIRTUAL_AUDIO_ROUTE_NOT_READY" };
  if (!input.setSinkSupported) return { ok: false, code: "SET_SINK_ID_UNSUPPORTED" };
  return { ok: true, sinkId: input.sinkId };
}

export function shouldSynthesizeSessionSpeech(input: {
  referenceMode: boolean;
  text: string;
}): boolean {
  return !input.referenceMode && input.text.trim().length > 0;
}
