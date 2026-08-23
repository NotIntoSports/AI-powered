export type ClonedVoiceTtsFailure = {
  status: 502 | 503;
  code: "CLONED_VOICE_QUOTA_EXPIRED" | "CLONED_VOICE_UNAVAILABLE";
  message: string;
};

export function classifyClonedVoiceTtsFailure(cause: unknown): ClonedVoiceTtsFailure {
  const detail = cause instanceof Error ? cause.message : String(cause || "");
  if (/FREE_TRIAL_EXPIRED/i.test(detail)) {
    return {
      status: 503,
      code: "CLONED_VOICE_QUOTA_EXPIRED",
      message: "复刻音色服务额度已过期，请管理员续费后重试，本次未播放默认音色"
    };
  }
  return {
    status: 502,
    code: "CLONED_VOICE_UNAVAILABLE",
    message: "复刻音色合成失败，本次未播放备用音色"
  };
}

export function clonedVoicePreviewMessage(code?: string) {
  return code === "CLONED_VOICE_QUOTA_EXPIRED"
    ? "复刻音色服务额度已过期，请管理员续费后重试，本次未播放默认音色。"
    : "复刻音色合成失败，本次未播放备用音色。";
}
