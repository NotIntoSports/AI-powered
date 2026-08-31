export type AutoSessionStartInput = {
  bridgeState: "off" | "waiting" | "captured" | "backoff" | "needs-manual" | "starting" | "agent-missing";
  bridgeSessionKey?: string;
  sessionStatus: "idle" | "running" | "finished";
  assistantRole?: string;
  pending: boolean;
  attemptedSessionKey?: string;
};

export type AutoSessionStartDecision = {
  shouldStart: boolean;
  message: string;
};

/** 纯门禁：只有一条已经完全建好的桥接线路可以自动创建一次互动。 */
export function decideAutoSessionStart(input: AutoSessionStartInput): AutoSessionStartDecision {
  if (input.bridgeState !== "captured" || !input.bridgeSessionKey) {
    return { shouldStart: false, message: "等待会议音频桥接" };
  }
  if (input.sessionStatus === "running") {
    return { shouldStart: false, message: "自动对话已开始" };
  }
  if (!input.assistantRole) {
    return { shouldStart: false, message: "请选择助手角色" };
  }
  if (input.pending) {
    return { shouldStart: false, message: "正在自动开始互动" };
  }
  if (input.attemptedSessionKey === input.bridgeSessionKey) {
    return { shouldStart: false, message: "本场会议已尝试自动开始" };
  }
  return { shouldStart: true, message: "正在自动开始互动" };
}
