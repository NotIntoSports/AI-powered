export type SubtitleEvent = {
  userId: string;
  sequence: number;
  text: string;
  definite: boolean;
  language: string;
};

export type SubtitleLine = {
  userId: string;
  sequence: number;
  text: string;
  final: boolean;
  language: string;
  receivedAt: number;
};

export function mergeSubtitle(
  state: SubtitleLine[],
  event: SubtitleEvent,
  receivedAt = Date.now()
): SubtitleLine[] {
  const existing = state.find((item) =>
    item.userId === event.userId && item.sequence === event.sequence
  );
  if (existing?.final && !event.definite) return state;
  const next: SubtitleLine = {
    userId: event.userId,
    sequence: event.sequence,
    text: event.text,
    final: event.definite,
    language: event.language,
    receivedAt
  };
  return [
    ...state.filter((item) =>
      item.userId !== event.userId || item.sequence !== event.sequence
    ),
    next
  ].sort((left, right) => left.sequence - right.sequence || left.receivedAt - right.receivedAt);
}
