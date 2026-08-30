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
import { ConfigStatus, SecretField } from "../config-status";

export default function RTCSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicRTCSettings | null>(null);
  const [language, setLanguage] = useState("zh");
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
    if (data.language) setLanguage(data.language);
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
      language,
      enabled,
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
      setLivekitApiSecret("");
      setAsrApiKey("");
      setNotice(data.available ? "LiveKit RTC 配置已写入数据库并可用。" : "已保存，但 LiveKit 尚未就绪。");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/rtc/test", {
        method: "POST",
        body: JSON.stringify(payload())
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
          <div className="card-head">
            <h2>LiveKit 字幕线路</h2>
            <ConfigStatus
              ready={Boolean(config?.available)}
              readyText="已配置 · LiveKit 可用"
              waitText="尚未配齐 URL、API Key 和 Secret"
            />
          </div>
          <p className="muted">
            自建 SFU 负责实时推流与字幕分发。Secret 加密存储，页面不回显明文。
          </p>
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
            线路：{config?.provider || "livekit"}
            {config?.livekitAvailable ? " · LiveKit 就绪" : " · LiveKit 未就绪"}
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>LiveKit 连接</h2>
            <ConfigStatus
              ready={Boolean(config?.livekitAvailable)}
              readyText="已配置并可用"
              waitText="尚未配齐 URL、API Key 和 Secret"
            />
          </div>
          <label>
            LiveKit URL
            <input value={livekitUrl} onChange={(event) => setLivekitUrl(event.target.value)} placeholder="wss://livekit.example.com" />
          </label>
          <label>
            API Key
            <input value={livekitApiKey} onChange={(event) => setLivekitApiKey(event.target.value)} />
          </label>
          <SecretField
            label="API Secret"
            configured={Boolean(config?.livekitSecretConfigured)}
            value={livekitApiSecret}
            onChange={setLivekitApiSecret}
          />
          <div className="row">
            <button className="secondary" type="button" disabled={busy} onClick={() => void test()}>测试 LiveKit</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>流式 ASR（可选）</h2>
            <ConfigStatus
              ready={Boolean(config?.asrKeyConfigured && config.asrBaseUrl)}
              readyText="已配置备用 ASR"
              waitText="未配置（LiveKit Agent 仍可用阿里云 NLS）"
            />
          </div>
          <p className="muted">OpenAI-compatible 流式 ASR。不填也不影响 LiveKit 推流与 Agent 字幕。</p>
          <label>
            ASR 地址
            <input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} placeholder="https://asr.example.com/v1" />
          </label>
          <label>
            ASR 模型
            <input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} placeholder="whisper-1" />
          </label>
          <SecretField
            label="ASR API Key"
            configured={Boolean(config?.asrKeyConfigured)}
            value={asrApiKey}
            onChange={setAsrApiKey}
          />
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
