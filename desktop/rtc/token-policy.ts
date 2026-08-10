export type RtcTokenConfig =
  | { mode: "production"; tokenServiceUrl: string }
  | { mode: "trial"; token: string; expiresAt: string };

export function validateRtcTokenConfig(config: RtcTokenConfig, now = Date.now()): void {
  if (config.mode === "production") {
    const url = new URL(config.tokenServiceUrl);
    if (url.protocol !== "https:") throw new Error("RTC_TOKEN_SERVICE_REQUIRES_HTTPS");
    return;
  }
  if (!config.token.trim()) throw new Error("RTC_TRIAL_TOKEN_REQUIRED");
  if (Date.parse(config.expiresAt) <= now) throw new Error("RTC_TRIAL_TOKEN_EXPIRED");
}
