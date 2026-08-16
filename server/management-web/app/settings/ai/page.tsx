"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type AITestResult,
  type PublicAISettings
} from "../../../lib/control-api";
import { ConfigStatus, SecretField } from "../config-status";

export default function AISettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicAISettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [questionTimeoutMs, setQuestionTimeoutMs] = useState(60000);
  const [reportTimeoutMs, setReportTimeoutMs] = useState(180000);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/ai");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取 AI 配置")));
      return;
    }
    const data = result.body as PublicAISettings;
    setConfig(data);
    if (data.baseUrl) setBaseUrl(data.baseUrl);
    if (data.model) setModel(data.model);
    setEnabled(data.enabled);
    if (data.questionTimeoutMs) setQuestionTimeoutMs(data.questionTimeoutMs);
    if (data.reportTimeoutMs) setReportTimeoutMs(data.reportTimeoutMs);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function payload(includeKey: boolean) {
    return {
      provider: "openai-compatible",
      baseUrl,
      model,
      questionTimeoutMs,
      reportTimeoutMs,
      enabled,
      ...(includeKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/ai", {
        method: "PUT",
        body: JSON.stringify(payload(true))
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      const data = result.body as PublicAISettings;
      setConfig(data);
      setApiKey("");
      setNotice(data.available ? "AI 配置已写入数据库并可用。" : "已保存，但配置尚未就绪。");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/ai/test", {
        method: "POST",
        body: JSON.stringify(payload(true))
      });
      const body = result.body as AITestResult;
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
          <h2>AI 模型</h2>
          <ConfigStatus
            ready={Boolean(config?.available)}
            readyText="已配置并可用"
            waitText="尚未配齐模型或密钥"
          />
        </div>
        <p className="muted">
          配置写入 PostgreSQL。API Key 使用服务器主密钥加密存储，读取接口不会返回明文。
        </p>
        <label>
          Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
        </label>
        <label>
          模型 ID
          <input value={model} onChange={(event) => setModel(event.target.value)} required />
        </label>
        <SecretField
          label="API Key"
          configured={Boolean(config?.apiKeyConfigured)}
          value={apiKey}
          onChange={setApiKey}
        />
        <div className="row">
          <label>
            追问超时（毫秒）
            <input type="number" min={1000} max={600000} value={questionTimeoutMs} onChange={(event) => setQuestionTimeoutMs(Number(event.target.value))} />
          </label>
          <label>
            报告超时（毫秒）
            <input type="number" min={1000} max={600000} value={reportTimeoutMs} onChange={(event) => setReportTimeoutMs(Number(event.target.value))} />
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
