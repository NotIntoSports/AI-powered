"use client";

import { FormEvent, useEffect, useState } from "react";

type PublicModelConfig = {
  apiKeyConfigured: boolean;
  modelConfigured: boolean;
  localEndpoint: boolean;
  baseUrl: string;
  model: string;
  source: "settings" | "environment" | "default";
};

const sourceLabels = {
  settings: "Windows 加密配置",
  environment: "环境变量",
  default: "尚未配置"
};

export function ModelSettings() {
  const [config, setConfig] = useState<PublicModelConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [apiKey, setApiKey] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("正在读取本机配置…");

  useEffect(() => {
    fetch("/api/settings/model", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "读取配置失败");
        setConfig(data);
        setBaseUrl(data.baseUrl);
        setModel(data.model);
        setMessage(
          data.localEndpoint && !data.apiKeyConfigured
            ? "本机模型无需密钥，可直接生成追问和纪要。"
            : data.apiKeyConfigured
              ? "模型密钥已配置。"
              : "远程模型需要填写 API 密钥。"
        );
      })
      .catch((cause) => setMessage(cause instanceof Error ? cause.message : "读取配置失败"));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("正在使用 Windows DPAPI 加密并保存…");
    try {
      const response = await fetch("/api/settings/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          model,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "保存失败");
      setConfig(data);
      setApiKey("");
      setMessage(
        data.modelConfigured
          ? data.localEndpoint && !data.apiKeyConfigured
            ? "本机无密钥模型已保存并立即生效。"
            : "配置已安全保存并立即生效。"
          : "地址已保存，但远程模型仍缺少 API 密钥。"
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setWorking(false);
    }
  }

  async function clear() {
    if (!window.confirm("确定删除本机加密保存的模型密钥和设置吗？")) return;
    setWorking(true);
    try {
      const response = await fetch("/api/settings/model", { method: "DELETE" });
      if (!response.ok) throw new Error("删除失败");
      const next: PublicModelConfig = {
        apiKeyConfigured: false,
        modelConfigured: false,
        localEndpoint: false,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        source: "settings"
      };
      setConfig(next);
      setBaseUrl(next.baseUrl);
      setModel(next.model);
      setApiKey("");
      setMessage("本机模型密钥已删除。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setWorking(false);
    }
  }

  async function testConnection() {
    setWorking(true);
    setMessage("正在检查模型服务和模型名称…");
    try {
      const response = await fetch("/api/settings/model/test", { method: "POST" });
      const data = await response.json();
      setMessage(data.message || (response.ok ? "模型连接正常。" : "模型连接失败。"));
    } catch {
      setMessage("无法调用本机模型连接测试。");
    } finally {
      setWorking(false);
    }
  }

  return (
    <article className="card modelSettings">
      <div className="cardHeading">
        <h2>AI 模型设置</h2>
        <span className={config?.modelConfigured ? "ready" : ""}>
          {config ? sourceLabels[config.source] : "读取中"}
        </span>
      </div>
      <form onSubmit={save}>
        <label>
          OpenAI-compatible 地址
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.openai.com/v1"
            required
          />
        </label>
        <label>
          模型名称
          <input value={model} onChange={(event) => setModel(event.target.value)} required />
        </label>
        <label>
          API 密钥
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            placeholder={config?.apiKeyConfigured ? "已配置；留空保持不变" : "仅发送到本机服务"}
          />
        </label>
        <div className="modelSettingsActions">
          <button disabled={working}>{working ? "正在保存…" : "保存模型配置"}</button>
          <button
            type="button"
            className="secondary"
            disabled={working || !config?.modelConfigured}
            onClick={testConnection}
          >
            测试模型连接
          </button>
          {config?.source === "settings" && (
            <button type="button" className="ghost" disabled={working} onClick={clear}>删除本机配置</button>
          )}
        </div>
      </form>
      <p className="modelSettingsMessage">{message}</p>
      <p className="muted">
        本机回环地址可不填密钥；远程地址必须使用 HTTPS 和 API 密钥。密钥由当前 Windows 用户的 DPAPI 加密，GET 接口永不返回密钥。
      </p>
    </article>
  );
}
