export type OutputRoute = "silent" | "human-mic" | "tts";

export function selectOutputRoute(input: {
  muted: boolean;
  humanMic: boolean;
  tts: boolean;
}): OutputRoute {
  if (input.muted) return "silent";
  if (input.humanMic) return "human-mic";
  if (input.tts) return "tts";
  return "silent";
}
