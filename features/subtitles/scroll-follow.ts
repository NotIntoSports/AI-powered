export function isTranscriptNearBottom(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  threshold?: number;
}): boolean {
  const threshold = Math.max(0, input.threshold ?? 56);
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

export type TranscriptFollowMode = "following" | "reviewing-history" | "programmatic-scroll";

export type TranscriptFollowState = {
  mode: TranscriptFollowMode;
  userScrollUp: boolean;
};

export type TranscriptFollowEvent =
  | { type: "user-scroll-up" }
  | { type: "scroll-position"; nearBottom: boolean }
  | { type: "programmatic-start" }
  | { type: "programmatic-end"; nearBottom: boolean }
  | { type: "content-resized" };

export function createTranscriptFollowState(): TranscriptFollowState {
  return { mode: "following", userScrollUp: false };
}

export function reduceTranscriptFollowState(
  state: TranscriptFollowState,
  event: TranscriptFollowEvent,
): TranscriptFollowState {
  if (event.type === "user-scroll-up") {
    return state.mode === "programmatic-scroll" ? state : { ...state, userScrollUp: true };
  }
  if (event.type === "programmatic-start") {
    return { mode: "programmatic-scroll", userScrollUp: false };
  }
  if (event.type === "programmatic-end") {
    return event.nearBottom
      ? { mode: "following", userScrollUp: false }
      : { mode: "following", userScrollUp: false };
  }
  if (event.type === "content-resized") return state;
  if (event.nearBottom) return { mode: "following", userScrollUp: false };
  if (state.mode === "programmatic-scroll" || !state.userScrollUp) return state;
  return { mode: "reviewing-history", userScrollUp: false };
}
