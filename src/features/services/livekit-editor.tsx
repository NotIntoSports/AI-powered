import { FormEvent, useCallback, useEffect, useState } from "react";

import * as api from "../../api/commands";
import type { CommandResult, PublicConfig } from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

export function LiveKitEditor() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [message, setMessage] = useState("正在读取本地配置…");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  const reload = useCallback(async () => {
    try {
      const result = await api.getConfigPublic();
      if (result.ok) {
        setConfig(result.data);
        setUrl(result.data.transport.livekit.url ?? "");
        setMessage("");
      } else {
        setMessage(errorText(result.error));
      }
    } catch {
      setMessage("IPC_UNAVAILABLE：无法读取本地配置");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<CommandResult<unknown>>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      await reload();
      if (!result.ok) {
        setMessage(errorText(result.error));
        return false;
      }
      setMessage(success);
      return true;
    } catch {
      await reload();
      setMessage("IPC_UNAVAILABLE：本地操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await run(
        () =>
          api.saveLiveKitSettings({
            url: url.trim() || null,
            apiKey: apiKey.trim() || null,
            apiSecret: apiSecret.trim() || null,
          }),
        "LiveKit 设置已保存，请先测试再启用",
      );
    } finally {
      setApiKey("");
      setApiSecret("");
    }
  }

  const livekit = config?.transport.livekit;

  return (
    <section className="service-panel livekit-editor" aria-labelledby="livekit-editor-heading">
      <h2 id="livekit-editor-heading">LiveKit</h2>
      <p>默认关闭。媒体只会在以后明确使用 LiveKit 时发送到该服务，不会经过作者服务器。</p>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      <form className="service-form" onSubmit={submit}>
        <label>
          服务 URL
          <input
            type="url"
            placeholder="wss://livekit.example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <small>留空会保留已保存的密钥</small>
        </label>
        <label>
          API Secret
          <input
            type="password"
            autoComplete="new-password"
            value={apiSecret}
            onChange={(event) => setApiSecret(event.target.value)}
          />
          <small>留空会保留已保存的密钥</small>
        </label>
        <button disabled={busy} type="submit">
          保存 LiveKit
        </button>
      </form>
      <p>状态：{livekit?.enabled ? "已启用" : "默认关闭"}</p>
      <p>
        密钥：
        {livekit?.apiKey?.configured && livekit.apiSecret?.configured ? "已安全保存" : "未配置"}
      </p>
      <p>{livekit?.ready ? "测试通过" : "尚未就绪"}</p>
      <div className="service-actions">
        <button disabled={busy} onClick={() => void run(() => api.testLiveKitSettings(), "LiveKit 测试通过")}>
          测试
        </button>
        <button
          disabled={busy || !livekit?.ready}
          onClick={() => void run(() => api.enableLiveKitSettings(true), "LiveKit 已启用")}
        >
          启用
        </button>
        <button disabled={busy} onClick={() => void run(() => api.enableLiveKitSettings(false), "LiveKit 已关闭")}>
          关闭
        </button>
      </div>
    </section>
  );
}
