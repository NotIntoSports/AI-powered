export const AUTO_BRIDGE_POLL_MS = 5_000;
export const AUTO_BRIDGE_BACKOFF_MS = 10_000;
export const AUTO_BRIDGE_MAX_ATTEMPTS = 3;

export type MeetingProcessLike = { pid: number; name: string; title: string };

export type AutoBridgeMachine = {
  capturedPid: number | null;
  attempts: number;
  lastFailureAt: number | null;
  awaitingManual: boolean;
};

export type AutoBridgeAction =
  | "idle"
  | "waiting"
  | "holding"
  | "backoff"
  | "stop"
  | "needs-manual"
  | { type: "start"; pid: number };

export function initialAutoBridgeMachine(): AutoBridgeMachine {
  return { capturedPid: null, attempts: 0, lastFailureAt: null, awaitingManual: false };
}

/**
 * 纯函数决策状态机：根据当前进程快照与机器状态给出下一步动作，不产生任何副作用。
 * 尝试计数 / 退避起点由 controller 通过 recordAttempt / recordFailure 维护。
 */
export function decideAutoBridge(
  processes: MeetingProcessLike[],
  input: {
    now: number;
    machine: AutoBridgeMachine;
    enabled: boolean;
    software: string;
    sessionRunning?: boolean;
  }
): { action: AutoBridgeAction; machine: AutoBridgeMachine } {
  const { now, enabled, software } = input;
  if (!enabled || !software) {
    return { action: "idle", machine: initialAutoBridgeMachine() };
  }

  const machine = { ...input.machine };
  const target = software.toLowerCase();
  const matches = processes.filter(
    (process) => process.name.toLowerCase() === target && process.title.trim() !== ""
  );

  // 已捕获进程：存活则保持桥接；消失则停止并整体复位，等待下一场。
  if (machine.capturedPid !== null) {
    if (matches.some((process) => process.pid === machine.capturedPid)) {
      return { action: "holding", machine };
    }
    return { action: "stop", machine: initialAutoBridgeMachine() };
  }

  // 手动会话正在运行：自动桥接让位，不触发新捕获。
  if (input.sessionRunning) return { action: "holding", machine };

  // 已标记需要人工介入：会议消失则复位；新会议出现则重新武装并立即尝试捕获。
  if (machine.awaitingManual) {
    if (matches.length === 0) return { action: "waiting", machine: initialAutoBridgeMachine() };
    return { action: { type: "start", pid: matches[0].pid }, machine: initialAutoBridgeMachine() };
  }

  // 失败退避：未到退避窗口则等待；退避结束后尝试次数已耗尽则转人工。
  if (machine.lastFailureAt !== null) {
    if (now - machine.lastFailureAt < AUTO_BRIDGE_BACKOFF_MS) return { action: "backoff", machine };
    if (machine.attempts >= AUTO_BRIDGE_MAX_ATTEMPTS) {
      return { action: "needs-manual", machine: { ...machine, awaitingManual: true } };
    }
  }

  const next = matches[0];
  if (!next) return { action: "waiting", machine };
  return { action: { type: "start", pid: next.pid }, machine };
}

/** 启动尝试登记（controller 在每次 startBridgeSession 调用前使用）。 */
export function recordAttempt(machine: AutoBridgeMachine, now: number): AutoBridgeMachine {
  return { ...machine, attempts: machine.attempts + 1, lastFailureAt: now };
}

/** 启动成功后登记捕获的 pid。 */
export function recordCaptured(machine: AutoBridgeMachine, pid: number): AutoBridgeMachine {
  return { ...machine, capturedPid: pid };
}

/** 启动失败后登记退避起点。 */
export function recordFailure(machine: AutoBridgeMachine, now: number): AutoBridgeMachine {
  return { ...machine, lastFailureAt: now };
}
