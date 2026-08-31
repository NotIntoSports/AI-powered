"use client";

import { useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import { displayError, parseAPIError, requestJSON, type PublicRTCSettings } from "../../../lib/control-api";
import { ConfigStatus, SecretField } from "../config-status";

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const result = await requestJSON(path, init);
  if (!result.response.ok) throw new Error(displayError(parseAPIError(result.body, "请求失败")));
  return result.body as T;
}

export default function RtcSettingsPage() {
  const { me } = useAdminSession();
  const [config, setConfig] = useState<PublicRTCSettings | null>(null);
  const [language, setLanguage] = useState("zh-CN");
  const [enabled, setEnabled] = useState(false);
  const [livekitUrl, setLivekitUrl] = useState("");
  const [livekitApiKey, setLivekitApiKey] = useState("");
  const [livekitApiSecret, setLivekitApiSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    const data = await api<PublicRTCSettings>("/api/v1/admin/settings/rtc");
    setConfig(data);
    setLanguage(data.language || "zh-CN");
    setEnabled(data.enabled);
    setLivekitUrl(data.livekitUrl || "");
    setLivekitApiKey("");
    setLivekitApiSecret("");
  }

  useEffect(() => {
    if (!me) return;
    load().catch((error) => setNotice(error instanceof Error ? error.message : "读取 RTC 配置失败"));
  }, [me]);

  async function save() {
    setBusy(true);
    setNotice("");
    try {
      await api("/api/v1/admin/settings/rtc", {
        method: "PUT",
        body: JSON.stringify({ language, enabled, livekitUrl, livekitApiKey, livekitApiSecret }),
      });
      await load();
      setEditing(false);
      setNotice("LiveKit RTC 配置已保存。新会话会读取当前启用的语音线路，进行中的会话不会热切。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ ok: boolean; message?: string }>("/api/v1/admin/settings/rtc/test", { method: "POST" });
      setNotice(result.message || (result.ok ? "LiveKit 连接正常。" : "LiveKit 连接失败。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell me={me}>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>LiveKit RTC</h2>
            <p className="muted">这里只管理房间连接、字幕语言和 Agent 启用状态。模型组合统一在“语音线路管理”中创建并启用。</p>
          </div>
          <ConfigStatus ready={Boolean(config?.livekitConfigured)} readyText="LiveKit 已配置" waitText="LiveKit 尚未配置" />
        </div>
        {notice ? <p className="notice">{notice}</p> : null}
        <fieldset className="form-grid" disabled={!editing}>
          <label>LiveKit URL<input value={livekitUrl} onChange={(event) => setLivekitUrl(event.target.value)} /></label>
          <label>字幕语言<input value={language} onChange={(event) => setLanguage(event.target.value)} /></label>
          <SecretField label="API Key" value={livekitApiKey} onChange={setLivekitApiKey} configured={Boolean(config?.livekitApiKey)} />
          <SecretField label="API Secret" value={livekitApiSecret} onChange={setLivekitApiSecret} configured={Boolean(config?.livekitSecretConfigured)} />
          <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用 LiveKit Agent</label>
        </fieldset>
        <div className="actions">
          {editing ? (
            <>
              <button disabled={busy} onClick={save}>保存</button>
              <button className="secondary" disabled={busy} onClick={() => { setEditing(false); load().catch(() => undefined); }}>取消</button>
            </>
          ) : <button onClick={() => setEditing(true)}>编辑</button>}
          <button className="secondary" disabled={busy || editing} onClick={testConnection}>连接测试</button>
        </div>
      </section>
    </ConsoleShell>
  );
}
