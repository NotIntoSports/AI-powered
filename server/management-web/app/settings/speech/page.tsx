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

type SpeechProvider = "volcengine" | "aliyun";

export default function SpeechSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicSpeechSettings | null>(null);
  const [activeProvider, setActiveProvider] = useState<SpeechProvider>("aliyun");
  const [appId, setAppId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [ttsResourceId, setTtsResourceId] = useState("seed-icl-2.0");
  const [asrResourceId, setAsrResourceId] = useState("volc.bigasr.auc_turbo");
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [aliyunAppKey, setAliyunAppKey] = useState("");
  const [aliyunVoice, setAliyunVoice] = useState("xiaoyun");
  const [aliyunGateway, setAliyunGateway] = useState("https://nls-gateway-cn-shanghai.aliyuncs.com");
  const [aliyunEnabled, setAliyunEnabled] = useState(true);
  const [aliyunAccessKeyId, setAliyunAccessKeyId] = useState("");
  const [aliyunAccessKeySecret, setAliyunAccessKeySecret] = useState("");
  const [aliyunToken, setAliyunToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(data: PublicSpeechSettings) {
    setConfig(data);
    if (data.activeProvider === "aliyun" || data.activeProvider === "volcengine") {
      setActiveProvider(data.activeProvider);
    }
    setAppId(data.appId || "");
    setSpeakerId(data.speakerId || "");
    if (data.ttsResourceId) setTtsResourceId(data.ttsResourceId);
    if (data.asrResourceId) setAsrResourceId(data.asrResourceId);
    setEnabled(data.enabled);
    setAliyunAppKey(data.aliyunAppKey || "");
    if (data.aliyunVoice) setAliyunVoice(data.aliyunVoice);
    if (data.aliyunGateway) setAliyunGateway(data.aliyunGateway);
    setAliyunEnabled(data.aliyunEnabled !== false);
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
      activeProvider,
      appId,
      speakerId,
      ttsResourceId,
      asrResourceId,
      enabled,
      aliyunAppKey,
      aliyunVoice,
      aliyunGateway,
      aliyunEnabled,
      ...(includeSecrets && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(includeSecrets && accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      ...(includeSecrets && secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
      ...(includeSecrets && aliyunAccessKeyId.trim() ? { aliyunAccessKeyId: aliyunAccessKeyId.trim() } : {}),
      ...(includeSecrets && aliyunAccessKeySecret.trim() ? { aliyunAccessKeySecret: aliyunAccessKeySecret.trim() } : {}),
      ...(includeSecrets && aliyunToken.trim() ? { aliyunToken: aliyunToken.trim() } : {})
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
      setAliyunAccessKeyId("");
      setAliyunAccessKeySecret("");
      setAliyunToken("");
      setNotice(data.available ? "语音配置已写入数据库并可用。" : "已保存，但当前线路尚未就绪。");
    } finally {
      setBusy(false);
    }
  }

  async function test(provider: SpeechProvider) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/speech/test", {
        method: "POST",
        body: JSON.stringify({ ...payload(true), testProvider: provider })
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

  const currentReady = Boolean(config?.available);
  const currentLabel =
    activeProvider === "aliyun"
      ? config?.aliyunAvailable
        ? "当前线路 · 阿里云已连通"
        : "当前线路 · 阿里云未就绪"
      : config?.volcengineAvailable
        ? "当前线路 · 豆包已连通"
        : "当前线路 · 豆包未就绪";

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      <form onSubmit={save} autoComplete="off">
        <section className="card">
          <div className="card-head">
            <h2>语音线路</h2>
            <ConfigStatus
              ready={currentReady}
              readyText={currentLabel}
              waitText="当前线路尚未连通"
            />
          </div>
          <p className="muted">
            平时只看连通状态。阿里云与豆包可同时保存；展开后改密钥。密钥加密入库，页面不回显明文。
          </p>
          <div className="status-grid">
            <div className={`status-chip ${config?.aliyunAvailable ? "ready" : ""}`}>
              <strong>阿里云 NLS</strong>
              <span>{config?.aliyunAvailable ? "已连通" : "未配置或未连通"}</span>
            </div>
            <div className={`status-chip ${config?.volcengineAvailable ? "ready" : ""}`}>
              <strong>豆包语音</strong>
              <span>{config?.volcengineAvailable ? "已连通" : "未配置或未连通"}</span>
            </div>
          </div>
          <label>
            当前线路
            <select
              value={activeProvider}
              onChange={(event) => setActiveProvider(event.target.value as SpeechProvider)}
            >
              <option value="aliyun">阿里云智能语音</option>
              <option value="volcengine">豆包语音（声音复刻）</option>
            </select>
          </label>
        </section>

        <details className="card config-details" open={!config?.aliyunAvailable && activeProvider === "aliyun"}>
          <summary>
            <span>阿里云智能语音</span>
            <ConfigStatus
              ready={Boolean(config?.aliyunAvailable)}
              readyText="已连通"
              waitText="未连通"
            />
          </summary>
          <div className="stack">
            <p className="muted">Appkey 来自智能语音交互控制台项目；AccessKey 用于 CreateToken。</p>
            <label>
              Appkey
              <input value={aliyunAppKey} onChange={(event) => setAliyunAppKey(event.target.value)} />
            </label>
            <SecretField
              label="AccessKey ID"
              configured={Boolean(config?.aliyunAccessKeyIdConfigured)}
              value={aliyunAccessKeyId}
              onChange={setAliyunAccessKeyId}
            />
            <SecretField
              label="AccessKey Secret"
              configured={Boolean(config?.aliyunAccessKeySecretConfigured)}
              value={aliyunAccessKeySecret}
              onChange={setAliyunAccessKeySecret}
            />
            <SecretField
              label="临时 Token（可选，24 小时有效）"
              configured={Boolean(config?.aliyunTokenConfigured)}
              value={aliyunToken}
              onChange={setAliyunToken}
            />
            <div className="row">
              <label>
                音色
                <input value={aliyunVoice} onChange={(event) => setAliyunVoice(event.target.value)} />
              </label>
              <label>
                网关
                <input value={aliyunGateway} onChange={(event) => setAliyunGateway(event.target.value)} />
              </label>
              <label>
                启用
                <select
                  value={aliyunEnabled ? "yes" : "no"}
                  onChange={(event) => setAliyunEnabled(event.target.value === "yes")}
                >
                  <option value="yes">启用</option>
                  <option value="no">停用</option>
                </select>
              </label>
            </div>
            <div className="row">
              <button className="secondary" type="button" disabled={busy} onClick={() => void test("aliyun")}>
                测试阿里云
              </button>
            </div>
          </div>
        </details>

        <details className="card config-details" open={!config?.volcengineAvailable && activeProvider === "volcengine"}>
          <summary>
            <span>豆包语音（声音复刻）</span>
            <ConfigStatus
              ready={Boolean(config?.volcengineAvailable)}
              readyText={config?.ttsAvailable && activeProvider === "volcengine" ? "已连通 · 可复刻" : "鉴权可用"}
              waitText="未连通"
            />
          </summary>
          <div className="stack">
      <p className="muted">录音和声音刻录在面试官本机完成。刻录结果绑定登录账号，该账号的合成播报使用自己的音色。管理网页不采集麦克风。</p>
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
              label="Secret Key（仅加密保存）"
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
              <button className="secondary" type="button" disabled={busy} onClick={() => void test("volcengine")}>
                测试豆包
              </button>
            </div>
          </div>
        </details>

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
