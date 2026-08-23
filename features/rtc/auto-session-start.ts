export type AutoSessionStartInput = {
  bridgeState: "off" | "waiting" | "captured" | "backoff" | "needs-manual" | "starting";
  bridgeSessionKey?: string;
  sessionStatus: "idle" | "running" | "finished";
  modelConfigured: boolean;
  stageConnected: boolean;
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
  if (!input.modelConfigured) {
    return { shouldStart: false, message: "AI 模型未就绪，暂不能自动开始" };
  }
  if (!input.stageConnected) {
    return { shouldStart: false, message: "播报引擎未在线，暂不能实时播报" };
  }
  if (input.pending) {
    return { shouldStart: false, message: "正在自动开始互动" };
  }
  if (input.attemptedSessionKey === input.bridgeSessionKey) {
    return { shouldStart: false, message: "本场会议已尝试自动开始" };
  }
  return { shouldStart: true, message: "正在自动开始互动" };
}
