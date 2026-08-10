export function canAutoSubmitTranscription(input: {
  sessionStatus: "idle" | "running" | "finished";
  currentRevision: number;
  capturedRevision: number;
  lastTranscriptRole?: "interviewer" | "candidate";
}) {
  return input.sessionStatus === "running" &&
    input.currentRevision === input.capturedRevision &&
    input.lastTranscriptRole === "interviewer";
}
