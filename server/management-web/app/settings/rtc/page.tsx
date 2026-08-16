"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type PublicRTCSettings,
  type RTCTestResult
} from "../../../lib/control-api";

export default function RTCSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicRTCSettings | null>(null);
  const [activeProvider, setActiveProvider] = useState<"volcengine" | "livekit">("volcengine");
  const [appId, setAppId] = useState("");
  const [language, setLanguage] = useState("zh");
  const [mode, setMode] = useState<"production" | "trial">("production");
  const [tokenServiceUrl, setTokenServiceUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [trialRoomId, setTrialRoomId] = useState("interview_test");
  const [trialUserId, setTrialUserId] = useState("bridge_test");
  const [trialExpiresAt, setTrialExpiresAt] = useState("");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [livekitApiKey, setLivekitApiKey] = useState("");
  const [livekitApiSecret, setLivekitApiSecret] = useState("");
  const [asrBaseUrl, setAsrBaseUrl] = useState("");
  const [asrModel, setAsrModel] = useState("");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(data: PublicRTCSettings) {
    setConfig(data);
    if (data.activeProvider === "livekit" || data.activeProvider === "volcengine") setActiveProvider(data.activeProvider);
    if (data.appId) setAppId(data.appId);
    if (data.language) setLanguage(data.language);
    if (data.mode === "production" || data.mode === "trial") setMode(data.mode);
    setTokenServiceUrl(data.tokenServiceUrl || "");
    setTrialRoomId(data.trialRoomId || "interview_test");
    setTrialUserId(data.trialUserId || "bridge_test");
    if (data.trialExpiresAt) setTrialExpiresAt(data.trialExpiresAt.slice(0, 16));
    setLivekitUrl(data.livekitUrl || "");
    setLivekitApiKey(data.livekitApiKey || "");
    setAsrBaseUrl(data.asrBaseUrl || "");
    setAsrModel(data.asrModel || "");
    setEnabled(data.enabled);
  }

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/rtc");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取 RTC 配置")));
      return;
    }
    apply(result.body as PublicRTCSettings);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function payload() {
    return {
      activeProvider,
      appId,
      language,
      mode,
      enabled,
      tokenServiceUrl: mode === "production" ? tokenServiceUrl : "",
      secret: secret.trim(),
      trialRoomId: mode === "trial" ? trialRoomId : "",
      trialUserId: mode === "trial" ? trialUserId : "",
      trialExpiresAt: mode === "trial" && trialExpiresAt ? new Date(trialExpiresAt).toISOString() : "",
      livekitUrl,
      livekitApiKey,
      livekitApiSecret: livekitApiSecret.trim(),
      asrBaseUrl,
      asrModel,
      asrApiKey: asrApiKey.trim()
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/rtc", {
        method: "PUT",
        body: JSON.stringify(payload())
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      const data = result.body as PublicRTCSettings;
      apply(data);
      setSecret("");
      setLivekitApiSecret("");
      setAsrApiKey("");
      setNotice(data.available ? "RTC 配置已写入数据库并可用。" : "已保存，但当前线路尚未就绪。");
    } finally {
      setBusy(false);
    }
  }

  async function test(provider: "volcengine" | "livekit") {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/rtc/test", {
        method: "POST",
        body: JSON.stringify({ ...payload(), testProvider: provider })
      });
      const body = result.body as RTCTestResult;
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "测试失败")));
        return;
      }
      setNotice(body.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      <form onSubmit={save} autoComplete="off">
        <section className="card">
          <h2>当前字幕线路</h2>
          <p className="muted">火山云 RTC 与自建 LiveKit 配置同时保存。切换只改当前线路，一场面试中途不会热切。自建压力大时切回火山云。</p>
          <label>
            当前线路
            <select value={activeProvider} onChange={(event) => setActiveProvider(event.target.value as "volcengine" | "livekit")}>
              <option value="volcengine">火山云 RTC</option>
              <option value="livekit">自建 LiveKit</option>
            </select>
          </label>
          <label>
            字幕语言
            <input value={language} onChange={(event) => setLanguage(event.target.value)} required />
          </label>
          <label>
            启用字幕
            <select value={enabled ? "yes" : "no"} onChange={(event) => setEnabled(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">停用</option>
            </select>
          </label>
          <p className="muted">
            当前可用：{config?.available ? "是" : "否"}
            {config?.volcengineAvailable ? " · 火山就绪" : " · 火山未就绪"}
            {config?.livekitAvailable ? " · LiveKit 就绪" : " · LiveKit 未就绪"}
          </p>
        </section>

        <section className="card">
          <h2>火山 RTC</h2>
          <p className="muted">
            AppID、模式和加密 Secret 写入数据库，读取接口不会返回 Secret。
            {config?.secretConfigured ? " 当前已保存火山密钥。" : " 试用模式需要 Token，正式模式可保存 Token 服务地址或 App Secret。"}
          </p>
          <label>
            RTC AppID
            <input value={appId} onChange={(event) => setAppId(event.target.value)} />
          </label>
          <label>
            鉴权模式
            <select value={mode} onChange={(event) => setMode(event.target.value as "production" | "trial")}>
              <option value="production">企业 Token 服务</option>
              <option value="trial">临时 Token（仅试用）</option>
            </select>
          </label>
          {mode === "production" ? (
            <>
              <label>
                Token 服务 HTTPS 地址
                <input type="url" value={tokenServiceUrl} onChange={(event) => setTokenServiceUrl(event.target.value)} />
              </label>
              <label>
                App Secret{config?.secretConfigured ? "（留空则保留已保存密钥）" : "（可选）"}
                <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" />
              </label>
            </>
          ) : (
            <>
              <label>
                临时 Token 房间 ID
                <input value={trialRoomId} onChange={(event) => setTrialRoomId(event.target.value)} pattern="[A-Za-z0-9_-]{1,128}" />
              </label>
              <label>
                临时 Token 用户 ID
                <input value={trialUserId} onChange={(event) => setTrialUserId(event.target.value)} pattern="[A-Za-z0-9_-]{1,128}" />
              </label>
              <label>
                临时 Token{config?.secretConfigured ? "（留空则保留已保存 Token）" : ""}
                <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" />
              </label>
              <label>
                到期时间
                <input type="datetime-local" value={trialExpiresAt} onChange={(event) => setTrialExpiresAt(event.target.value)} />
              </label>
            </>
          )}
          <div className="row">
            <button className="secondary" type="button" disabled={busy} onClick={() => void test("volcengine")}>测试火山 RTC</button>
          </div>
        </section>

        <section className="card">
          <h2>LiveKit</h2>
          <p className="muted">
            自建 SFU 地址、API Key 和 API Secret。Secret 加密存储，不会回传。
            {config?.livekitSecretConfigured ? " 当前已保存 LiveKit Secret。" : " 选为当前线路前必须填完整。"}
          </p>
          <label>
            LiveKit URL
            <input value={livekitUrl} onChange={(event) => setLivekitUrl(event.target.value)} placeholder="wss://livekit.example.com" />
          </label>
          <label>
            API Key
            <input value={livekitApiKey} onChange={(event) => setLivekitApiKey(event.target.value)} />
          </label>
          <label>
            API Secret{config?.livekitSecretConfigured ? "（留空则保留已保存密钥）" : ""}
            <input type="password" value={livekitApiSecret} onChange={(event) => setLivekitApiSecret(event.target.value)} autoComplete="new-password" />
          </label>
          <label>
            流式 ASR 地址（OpenAI-compatible，可选）
            <input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label>
            ASR 模型
            <input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} />
          </label>
          <label>
            ASR API Key{config?.asrKeyConfigured ? "（留空则保留已保存密钥）" : "（可选）"}
            <input type="password" value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} autoComplete="new-password" />
          </label>
          <div className="row">
            <button className="secondary" type="button" disabled={busy} onClick={() => void test("livekit")}>测试 LiveKit</button>
          </div>
        </section>

        <div className="row">
          <button type="submit" disabled={busy}>{busy ? "处理中…" : "保存到数据库"}</button>
        </div>
        {config?.updatedAt ? (
          <p className="muted">版本 {config.configVersion} · {config.updatedByUsername || "未知"} · {config.updatedAt}</p>
        ) : null}
      </form>
    </ConsoleShell>
  );
}
