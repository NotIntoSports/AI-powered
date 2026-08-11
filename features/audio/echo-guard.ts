export type EchoGuardPhase = "idle" | "awaiting-speech" | "speaking";

export type EchoGuardState = {
  phase: EchoGuardPhase;
  deadline: number;
};

export type EchoGuardCommand = "pause" | "start" | null;

export const idleEchoGuard: EchoGuardState = {
  phase: "idle",
  deadline: 0
};

export function armEchoGuard(now: number, timeoutMs = 30_000): {
  state: EchoGuardState;
  command: EchoGuardCommand;
} {
  return {
    state: { phase: "awaiting-speech", deadline: now + timeoutMs },
    command: "pause"
  };
}

export function advanceEchoGuard(
  current: EchoGuardState,
  ttsState: "idle" | "speaking" | "ready" | "error",
  now: number
): {
  state: EchoGuardState;
  command: EchoGuardCommand;
} {
  if (current.phase === "idle") {
    return { state: current, command: null };
  }
  if (ttsState === "speaking") {
    return {
      state: { ...current, phase: "speaking" },
      command: null
    };
  }
  if (
    current.phase === "speaking" ||
    ttsState === "error" ||
    now >= current.deadline
  ) {
    return { state: idleEchoGuard, command: "start" };
  }
  return { state: current, command: null };
}
