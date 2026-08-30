"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type PublicPipelineSettings
} from "../../../lib/control-api";
import { ConfigStatus } from "../config-status";

const TTS_OPTIONS = [
  { value: "speech:aliyun", label: "阿里云 NLS / CosyVoice（speech:aliyun）" },
  { value: "speech:volcengine", label: "豆包语音（speech:volcengine）" }
];

export default function PipelineSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicPipelineSettings | null>(null);
  const [mode, setMode] = useState<"cascaded" | "e2e">("cascaded");
  const [e2eProvider, setE2eProvider] = useState("tokenplan");
  const [cascadedTts, setCascadedTts] = useState("speech:aliyun");
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(data: PublicPipelineSettings) {
    setConfig(data);
    if (data.mode === "cascaded" || data.mode === "e2e") setMode(data.mode);
    if (data.e2eProvider) setE2eProvider(data.e2eProvider);
    if (data.cascadedTts) setCascadedTts(data.cascadedTts);
    setEnabled(data.enabled);
  }

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/pipeline");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取语音管线配置")));
      return;
    }
    apply(result.body as PublicPipelineSettings);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function payload() {
    return { mode, e2eProvider, cascadedTts, enabled };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/pipeline", {
        method: "PUT",
        body: JSON.stringify(payload())
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      const data = result.body as PublicPipelineSettings;
      apply(data);
      setNotice("语音管线配置已保存。");
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
            <h2>语音管线</h2>
            <ConfigStatus
              ready={Boolean(config?.enabled)}
              readyText="管线已启用"
              waitText="管线已停用"
            />
          </div>
          <p className="muted">
            级联模式：LiveKit Agent 负责 ASR（livekit-agent），TTS 由下方线路合成。端到端模式由 Agent 调用「AI 设置」中的 Token Plan / OpenAI 兼容多模态模型，直接生成回复并通过 agent.response.v1 下发。
          </p>
          <label>
            模式
            <select value={mode} onChange={(event) => setMode(event.target.value as "cascaded" | "e2e")}>
              <option value="cascaded">级联（ASR + TTS 分离）</option>
              <option value="e2e">端到端（E2E）</option>
            </select>
          </label>
          {mode === "e2e" ? (
            <label>
              E2E 提供方
              <input value={e2eProvider} onChange={(event) => setE2eProvider(event.target.value)} placeholder="tokenplan" />
              <span className="muted">模型 Base URL / API Key / Model 请在「AI 设置」页配置；Agent 通过内部接口读取。</span>
            </label>
          ) : (
            <>
              <p className="muted">ASR：{config?.cascadedAsr || "livekit-agent"}（固定，由 LiveKit Agent 消费 speech_configs）</p>
              <label>
                级联 TTS
                <select value={cascadedTts} onChange={(event) => setCascadedTts(event.target.value)}>
                  {TTS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            启用管线
            <select value={enabled ? "yes" : "no"} onChange={(event) => setEnabled(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">停用</option>
            </select>
          </label>
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
