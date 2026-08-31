"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  readJSON,
  requestJSON,
  type CatalogEntry,
  type PublicRTCSettings,
  type RTCTestResult
} from "../../../lib/control-api";
import { ConfigStatus, SecretField } from "../config-status";
import { SearchableCombobox } from "../../../components/searchable-combobox";
import { COSYVOICE_VOICES } from "../../../lib/cosyvoice-voice-catalog";

type SectionId = "pipeline" | "livekit";
type SectionFeedback = { ok?: string; error?: string };

function catalogValue(providerId: string, modelId: string) {
  if (!providerId || !modelId) return "";
  return `${providerId}::${modelId}`;
}

function parseCatalogValue(value: string) {
  const idx = value.indexOf("::");
  if (idx <= 0) return { providerId: "", modelId: "" };
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 2) };
}

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
  const [pipelineMode, setPipelineMode] = useState<"cascaded" | "e2e">("cascaded");
  const [asrRef, setAsrRef] = useState("");
  const [llmRef, setLlmRef] = useState("");
  const [ttsRef, setTtsRef] = useState("");
  const [e2eRef, setE2eRef] = useState("");
  const [ttsVoiceId, setTtsVoiceId] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [busySection, setBusySection] = useState<SectionId | "preview" | null>(null);
  const [feedback, setFeedback] = useState<Partial<Record<SectionId, SectionFeedback>>>({});
  const previewUrlRef = useRef("");
  const snapshotRef = useRef<Record<string, unknown> | null>(null);

  function apply(data: PublicRTCSettings) {
    setConfig(data);
    if (data.language) setLanguage(data.language);
    setLivekitUrl(data.livekitUrl || "");
    setLivekitApiKey(data.livekitApiKey || "");
    setAsrBaseUrl(data.asrBaseUrl || "");
    setAsrModel(data.asrModel || "");
    setEnabled(data.enabled);
    setPipelineMode(data.pipelineMode === "e2e" ? "e2e" : "cascaded");
    setAsrRef(catalogValue(data.asrProviderId || "", data.asrModelId || ""));
    setLlmRef(catalogValue(data.llmProviderId || "", data.llmModelId || ""));
    setTtsRef(catalogValue(data.ttsProviderId || "", data.ttsModelId || ""));
    setE2eRef(catalogValue(data.e2eProviderId || "", data.e2eModelId || ""));
    setTtsVoiceId(data.ttsVoiceId || "");
  }

  async function loadCatalog() {
    const result = await requestJSON("/api/v1/admin/settings/catalog");
    if (result.response.ok) {
      setCatalog(result.body as CatalogEntry[]);
    }
  }

  async function load() {
    const [rtcResult] = await Promise.all([requestJSON("/api/v1/admin/settings/rtc"), loadCatalog()]);
    if (!rtcResult.response.ok) {
      setError(displayError(parseAPIError(rtcResult.body, "无法读取 RTC 配置")));
      return;
    }
    apply(rtcResult.body as PublicRTCSettings);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const optionsFor = useMemo(() => {
    const make = (capability: string) =>
      catalog
        .filter((entry) => entry.enabled && entry.capability === capability)
        .map((entry) => ({
          value: catalogValue(entry.providerId, entry.modelId),
          label: entry.label,
          keywords: `${entry.providerName} ${entry.modelId} ${entry.displayName || ""}`
        }));
    return {
      asr: make("asr"),
      llm: make("llm"),
      tts: make("tts"),
      e2e: make("e2e")
    };
  }, [catalog]);

  const ttsModelId = parseCatalogValue(ttsRef).modelId;
  const ttsIsCosyVoice =
    ttsModelId.startsWith("cosyvoice") || parseCatalogValue(ttsRef).providerId === "speech:aliyun";
  const voiceOptions = useMemo(() => {
    if (pipelineMode !== "cascaded") return [];
    return COSYVOICE_VOICES.map((voice) => ({
      value: voice.id,
      label: `${voice.name} · ${voice.id}`,
      keywords: `${voice.name} ${voice.id} ${voice.language} ${voice.gender}`
    }));
  }, [pipelineMode]);

  function setSectionFeedback(section: SectionId, next: SectionFeedback) {
    setFeedback((current) => ({ ...current, [section]: next }));
  }

  function beginEdit(section: SectionId) {
    snapshotRef.current = {
      language,
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      asrBaseUrl,
      asrModel,
      asrApiKey,
      enabled,
      pipelineMode,
      asrRef,
      llmRef,
      ttsRef,
      e2eRef,
      ttsVoiceId
    };
    setEditing(section);
    setSectionFeedback(section, {});
    setError("");
  }

  function cancelEdit() {
    const snap = snapshotRef.current;
    if (snap) {
      setLanguage(String(snap.language || "zh"));
      setLivekitUrl(String(snap.livekitUrl || ""));
      setLivekitApiKey(String(snap.livekitApiKey || ""));
      setLivekitApiSecret(String(snap.livekitApiSecret || ""));
      setAsrBaseUrl(String(snap.asrBaseUrl || ""));
      setAsrModel(String(snap.asrModel || ""));
      setAsrApiKey(String(snap.asrApiKey || ""));
      setEnabled(Boolean(snap.enabled));
      setPipelineMode(snap.pipelineMode as "cascaded" | "e2e");
      setAsrRef(String(snap.asrRef || ""));
      setLlmRef(String(snap.llmRef || ""));
      setTtsRef(String(snap.ttsRef || ""));
      setE2eRef(String(snap.e2eRef || ""));
      setTtsVoiceId(String(snap.ttsVoiceId || ""));
    }
    snapshotRef.current = null;
    setEditing(null);
  }

  function fullPayload() {
    const asr = parseCatalogValue(asrRef);
    const llm = parseCatalogValue(llmRef);
    const tts = parseCatalogValue(ttsRef);
    const e2e = parseCatalogValue(e2eRef);
    return {
      language,
      enabled,
      livekitUrl,
      livekitApiKey,
      livekitApiSecret: livekitApiSecret.trim(),
      asrBaseUrl,
      asrModel,
      asrApiKey: asrApiKey.trim(),
      pipelineMode,
      asrProviderId: asr.providerId,
      asrModelId: asr.modelId,
      llmProviderId: llm.providerId,
      llmModelId: llm.modelId,
      ttsProviderId: tts.providerId,
      ttsModelId: tts.modelId,
      ttsVoiceId,
      e2eProviderId: e2e.providerId,
      e2eModelId: e2e.modelId
    };
  }

  async function putRtc(section: SectionId, successMessage: string) {
    setBusySection(section);
    setSectionFeedback(section, {});
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/rtc", {
        method: "PUT",
        body: JSON.stringify(fullPayload())
      });
      if (!result.response.ok) {
        setSectionFeedback(section, { error: displayError(parseAPIError(result.body, "保存失败")) });
        return false;
      }
      apply(result.body as PublicRTCSettings);
      setLivekitApiSecret("");
      setAsrApiKey("");
      setSectionFeedback(section, { ok: successMessage });
      setEditing(null);
      snapshotRef.current = null;
      return true;
    } finally {
      setBusySection(null);
    }
  }

  async function savePipeline() {
    await putRtc("pipeline", "互动管线已保存。");
  }

  async function saveLivekit() {
    await putRtc(
      "livekit",
      config?.available || (livekitUrl && livekitApiKey)
        ? "LiveKit 配置已保存。"
        : "已保存，但 LiveKit 尚未就绪。"
    );
  }

  async function testLivekit() {
    setBusySection("livekit");
    setSectionFeedback("livekit", {});
    try {
      const result = await requestJSON("/api/v1/admin/settings/rtc/test", {
        method: "POST",
        body: JSON.stringify(fullPayload())
      });
      const body = result.body as RTCTestResult;
      if (!result.response.ok) {
        setSectionFeedback("livekit", { error: displayError(parseAPIError(result.body, "测试失败")) });
        return;
      }
      setSectionFeedback("livekit", { ok: body.message || "测试完成" });
    } finally {
      setBusySection(null);
    }
  }

  async function previewVoice() {
    if (!ttsVoiceId) {
      setSectionFeedback("pipeline", { error: "请先选择音色" });
      return;
    }
    setBusySection("preview");
    setSectionFeedback("pipeline", {});
    try {
      const response = await fetch("/api/v1/admin/settings/speech/preview", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeProvider: "aliyun",
          aliyunVoice: ttsVoiceId,
          aliyunEnabled: true
        })
      });
      if (!response.ok) {
        const body = await readJSON(response);
        setSectionFeedback("pipeline", { error: displayError(parseAPIError(body, "试听失败")) });
        return;
      }
      const blob = await response.blob();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setSectionFeedback("pipeline", { ok: `正在试听：${ttsVoiceId}` });
    } catch {
      setSectionFeedback("pipeline", { error: "试听失败，请先在「语音」页配好阿里云并保存" });
    } finally {
      setBusySection(null);
    }
  }

  function Feedback({ section }: { section: SectionId }) {
    const item = feedback[section];
    if (!item?.ok && !item?.error) return null;
    return (
      <>
        {item.error ? <p className="error section-feedback">{item.error}</p> : null}
        {item.ok ? <p className="ok section-feedback">{item.ok}</p> : null}
      </>
    );
  }

  function SectionActions({
    section,
    onSave,
    extra
  }: {
    section: SectionId;
    onSave: () => void;
    extra?: ReactNode;
  }) {
    const isEditing = editing === section;
    const busy = busySection === section || busySection === "preview";
    return (
      <div className="row section-actions">
        {!isEditing ? (
          <button
            className="secondary allow-when-readonly"
            type="button"
            disabled={editing !== null && !isEditing}
            onClick={() => beginEdit(section)}
          >
            编辑
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void onSave()}>
              {busy && busySection === section ? "保存中…" : "保存本项"}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={cancelEdit}>
              取消
            </button>
          </>
        )}
        {extra}
      </div>
    );
  }

  const readOnly = (section: SectionId) => editing !== section;

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}

      <details className="card config-details" open>
        <summary>
          <span>互动管线</span>
        </summary>
        <div className="stack">
          <p className="muted">
            只管理 LiveKit Agent 使用的 ASR / LLM / TTS 或端对端模型。保存不会修改 Windows 客户端语音线路；已进行中的会话不会热切。
          </p>
          <Feedback section="pipeline" />
          <fieldset className="config-fieldset" disabled={readOnly("pipeline")}>
            <label>
              管线模式
              <select value={pipelineMode} onChange={(event) => setPipelineMode(event.target.value as "cascaded" | "e2e")}>
                <option value="cascaded">级联 ASR + LLM + TTS</option>
                <option value="e2e">端对端</option>
              </select>
            </label>
            {pipelineMode === "cascaded" ? (
              <div className="stack">
                <label>
                  ASR
                  <SearchableCombobox
                    options={optionsFor.asr}
                    value={asrRef}
                    onChange={setAsrRef}
                    placeholder="搜索 ASR 模型…"
                    disabled={readOnly("pipeline")}
                  />
                </label>
                <label>
                  LLM
                  <SearchableCombobox
                    options={optionsFor.llm}
                    value={llmRef}
                    onChange={setLlmRef}
                    placeholder="搜索 LLM 模型…"
                    disabled={readOnly("pipeline")}
                  />
                </label>
                <label>
                  TTS
                  <SearchableCombobox
                    options={optionsFor.tts}
                    value={ttsRef}
                    onChange={setTtsRef}
                    placeholder="搜索 TTS 模型…"
                    disabled={readOnly("pipeline")}
                  />
                </label>
                {ttsIsCosyVoice || !ttsRef || parseCatalogValue(ttsRef).providerId === "speech:aliyun" ? (
                  <>
                    <label>
                      官方免费音色
                      <SearchableCombobox
                        options={voiceOptions}
                        value={ttsVoiceId}
                        onChange={setTtsVoiceId}
                        placeholder="搜索音色…"
                        disabled={readOnly("pipeline")}
                      />
                    </label>
                    <p className="muted">试听使用「语音」页已保存的阿里云凭证，不会静默改用其它线路。</p>
                  </>
                ) : (
                  <p className="muted">当前 TTS 不是阿里云 CosyVoice / NLS 目录项时，不提供官方音色试听。</p>
                )}
              </div>
            ) : (
              <div className="stack">
                <label>
                  端对端模型
                  <SearchableCombobox
                    options={optionsFor.e2e}
                    value={e2eRef}
                    onChange={setE2eRef}
                    placeholder="搜索端对端模型…"
                    disabled={readOnly("pipeline")}
                  />
                </label>
                <p className="muted">
                  端对端模型使用会话内置语音，无独立官方音色目录。桌面端若尚未接入 Realtime/Omni，会返回 E2E_NOT_IMPLEMENTED，不会静默退回级联。
                </p>
              </div>
            )}
          </fieldset>
          <SectionActions
            section="pipeline"
            onSave={savePipeline}
            extra={
              pipelineMode === "cascaded" &&
              (ttsIsCosyVoice || parseCatalogValue(ttsRef).providerId === "speech:aliyun" || !ttsRef) ? (
                <button
                  className="secondary allow-when-readonly"
                  type="button"
                  disabled={busySection !== null || !ttsVoiceId}
                  onClick={() => void previewVoice()}
                >
                  {busySection === "preview" ? "试听中…" : "试听音色"}
                </button>
              ) : null
            }
          />
          {previewUrl ? <audio className="voice-preview" src={previewUrl} controls autoPlay /> : null}
        </div>
      </details>

      <details className="card config-details" open>
        <summary>
          <span>LiveKit 字幕线路</span>
          <ConfigStatus
            ready={Boolean(config?.available)}
            readyText="已配置 · LiveKit 可用"
            waitText="尚未配齐 URL、API Key 和 Secret"
          />
        </summary>
        <div className="stack">
          <p className="muted">自建 SFU 负责实时推流与字幕分发。Secret 加密存储，页面不回显明文。</p>
          <Feedback section="livekit" />
          <fieldset className="config-fieldset" disabled={readOnly("livekit")}>
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
            <details className="muted">
              <summary>流式 ASR（可选，不填也不影响 LiveKit 推流）</summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <label>
                  ASR 地址（OpenAI-compatible）
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
              </div>
            </details>
            <p className="muted">
              线路：{config?.provider || "livekit"}
              {config?.livekitAvailable ? " · LiveKit 就绪" : " · LiveKit 未就绪"}
            </p>
          </fieldset>
          <SectionActions
            section="livekit"
            onSave={saveLivekit}
            extra={
              <button
                className="secondary allow-when-readonly"
                type="button"
                disabled={busySection !== null}
                onClick={() => void testLivekit()}
              >
                测试 LiveKit
              </button>
            }
          />
        </div>
      </details>

      {config?.updatedAt ? (
        <p className="muted">版本 {config.configVersion} · {config.updatedByUsername || "未知"} · {config.updatedAt}</p>
      ) : null}
    </ConsoleShell>
  );
}
