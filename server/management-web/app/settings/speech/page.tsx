"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type PublicSpeechSettings,
  type SpeechTestResult
} from "../../../lib/control-api";
import { ConfigStatus, SecretField } from "../config-status";

export default function SpeechSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicSpeechSettings | null>(null);
  const [appId, setAppId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [ttsResourceId, setTtsResourceId] = useState("seed-icl-2.0");
  const [asrResourceId, setAsrResourceId] = useState("volc.bigasr.auc_turbo");
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(data: PublicSpeechSettings) {
    setConfig(data);
    setAppId(data.appId || "");
    setSpeakerId(data.speakerId || "");
    if (data.ttsResourceId) setTtsResourceId(data.ttsResourceId);
    if (data.asrResourceId) setAsrResourceId(data.asrResourceId);
    setEnabled(data.enabled);
  }

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/speech");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取语音配置")));
      return;
    }
    apply(result.body as PublicSpeechSettings);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function payload(includeSecrets: boolean) {
    return {
      appId,
      speakerId,
      ttsResourceId,
      asrResourceId,
      enabled,
      ...(includeSecrets && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(includeSecrets && accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      ...(includeSecrets && secretKey.trim() ? { secretKey: secretKey.trim() } : {})
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/speech", {
        method: "PUT",
        body: JSON.stringify(payload(true))
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      const data = result.body as PublicSpeechSettings;
      apply(data);
      setApiKey("");
      setAccessToken("");
      setSecretKey("");
      setNotice(data.available ? "语音配置已写入数据库并可用。" : "已保存，但鉴权尚未就绪。");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/speech/test", {
        method: "POST",
        body: JSON.stringify(payload(true))
      });
      const body = result.body as SpeechTestResult;
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
      <form className="card" onSubmit={save} autoComplete="off">
        <div className="card-head">
          <h2>豆包语音</h2>
          <ConfigStatus
            ready={Boolean(config?.available)}
            readyText={config?.ttsAvailable ? "已配置并可用于复刻音色" : "鉴权可用，请在客户端录音刻录"}
            waitText="尚未配齐 API Key 或 AppID/Token"
          />
        </div>
        <p className="muted">
          密钥使用服务器主密钥加密存储，读取接口不会返回明文。录音和声音刻录在面试官本机客户端完成，管理网页不采集麦克风。
        </p>
        <SecretField
          label="API Key（新控制台优先）"
          configured={Boolean(config?.apiKeyConfigured)}
          value={apiKey}
          onChange={setApiKey}
        />
        <label>
          AppID（旧控制台备用）
          <input value={appId} onChange={(event) => setAppId(event.target.value)} />
        </label>
        <SecretField
          label="Access Token（旧控制台备用）"
          configured={Boolean(config?.accessTokenConfigured)}
          value={accessToken}
          onChange={setAccessToken}
        />
        <SecretField
          label="Secret Key（仅加密保存，本轮不用于签名）"
          configured={Boolean(config?.secretKeyConfigured)}
          value={secretKey}
          onChange={setSecretKey}
        />
        <label>
          复刻音色 ID
          <input
            value={speakerId}
            onChange={(event) => setSpeakerId(event.target.value)}
            placeholder="可粘贴已有 S_xxxx，或留空由客户端录音生成"
          />
        </label>
        <div className="row">
          <label>
            TTS Resource
            <input value={ttsResourceId} onChange={(event) => setTtsResourceId(event.target.value)} />
          </label>
          <label>
            ASR Resource
            <input value={asrResourceId} onChange={(event) => setAsrResourceId(event.target.value)} />
          </label>
          <label>
            启用
            <select value={enabled ? "yes" : "no"} onChange={(event) => setEnabled(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">停用</option>
            </select>
          </label>
        </div>
        <div className="row">
          <button type="submit" disabled={busy}>{busy ? "处理中…" : "保存到数据库"}</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => void test()}>测试连接</button>
        </div>
        {config?.updatedAt ? (
          <p className="muted">版本 {config.configVersion} · {config.updatedByUsername || "未知"} · {config.updatedAt}</p>
        ) : null}
      </form>
    </ConsoleShell>
  );
}
