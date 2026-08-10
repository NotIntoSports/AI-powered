"use client";

import { FormEvent, useEffect, useState } from "react";

export function RtcSettings() {
  const [mode, setMode] = useState<"production" | "trial">("production");
  const [appId, setAppId] = useState("");
  const [language, setLanguage] = useState("zh");
  const [tokenServiceUrl, setTokenServiceUrl] = useState("");
  const [trialToken, setTrialToken] = useState("");
  const [trialExpiresAt, setTrialExpiresAt] = useState("");
  const [trialRoomId, setTrialRoomId] = useState("interview_test");
  const [trialUserId, setTrialUserId] = useState("bridge_test");
  const [message, setMessage] = useState("正在读取火山 RTC 配置…");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void fetch("/api/settings/rtc", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      setMode(data.mode);
      setAppId(data.appId);
      setLanguage(data.language);
      setTokenServiceUrl(data.tokenServiceUrl || "");
      if (data.trialExpiresAt) setTrialExpiresAt(data.trialExpiresAt.slice(0, 16));
      if (data.trialRoomId) setTrialRoomId(data.trialRoomId);
      if (data.trialUserId) setTrialUserId(data.trialUserId);
      setMessage(data.configured ? "火山 RTC 配置已保存。" : "请配置实时字幕服务。");
    }).catch(() => setMessage("读取 RTC 配置失败。"));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    try {
      const response = await fetch("/api/settings/rtc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, language, mode, tokenServiceUrl, trialToken, trialExpiresAt, trialRoomId, trialUserId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "保存失败");
      setTrialToken("");
      setMessage(mode === "trial" ? "试用 Token 已加密保存；到期后需更新。" : "正式 Token 服务已保存。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <article className="card modelSettings">
      <div className="cardHeading"><h2>火山 RTC 实时字幕</h2><span>{mode === "trial" ? "试用模式" : "正式模式"}</span></div>
      <form onSubmit={save}>
        <label>RTC AppID<input value={appId} onChange={(event) => setAppId(event.target.value)} required /></label>
        <label>字幕语言<input value={language} onChange={(event) => setLanguage(event.target.value)} required /></label>
        <label>鉴权模式
          <select value={mode} onChange={(event) => setMode(event.target.value as "production" | "trial")}>
            <option value="production">企业 Token 服务</option>
            <option value="trial">临时 Token（仅试用）</option>
          </select>
        </label>
        {mode === "production" ? (
          <label>Token 服务 HTTPS 地址<input type="url" value={tokenServiceUrl} onChange={(event) => setTokenServiceUrl(event.target.value)} required /></label>
        ) : <>
          <label>临时 Token 房间 ID<input value={trialRoomId} onChange={(event) => setTrialRoomId(event.target.value)} required pattern="[A-Za-z0-9_-]{1,128}" /></label>
          <label>临时 Token 用户 ID<input value={trialUserId} onChange={(event) => setTrialUserId(event.target.value)} required pattern="[A-Za-z0-9_-]{1,128}" /></label>
          <label>临时 Token<input type="password" value={trialToken} onChange={(event) => setTrialToken(event.target.value)} required autoComplete="new-password" /></label>
          <label>到期时间<input type="datetime-local" value={trialExpiresAt} onChange={(event) => setTrialExpiresAt(event.target.value)} required /></label>
        </>}
        <button disabled={working}>{working ? "正在保存…" : "保存 RTC 配置"}</button>
      </form>
      <p className="modelSettingsMessage">{message}</p>
      <p className="muted">客户端拒绝保存 AppKey。候选人音频将发送到火山引擎生成实时字幕，请先履行告知与同意义务。</p>
    </article>
  );
}
