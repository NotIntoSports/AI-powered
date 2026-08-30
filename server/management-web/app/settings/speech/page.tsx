"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type PublicSpeechSettings,
  type SpeechTestResult
} from "../../../lib/control-api";
import { ALIYUN_NLS_ASR_MODELS } from "../../../lib/aliyun-nls-asr-model-catalog";
import { COSYVOICE_VOICES, findCosyVoiceVoice } from "../../../lib/cosyvoice-voice-catalog";
import { VOLCENGINE_ASR_RESOURCES } from "../../../lib/volcengine-asr-resource-catalog";
import { VOLCENGINE_TTS_RESOURCES } from "../../../lib/volcengine-tts-resource-catalog";
import { ConfigStatus, SecretField } from "../config-status";

type SpeechProvider = "volcengine" | "aliyun";

const PREVIEW_TEXT = "你好，这是语音合成预览。";

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
  const [ttsVolume, setTtsVolume] = useState<number | "">(50);
  const [ttsSpeechRate, setTtsSpeechRate] = useState<number | "">(0);
  const [ttsPitchRate, setTtsPitchRate] = useState<number | "">(0);
  const [ttsSampleRate, setTtsSampleRate] = useState<number | "">(16000);
  const [asrEnableItn, setAsrEnableItn] = useState(true);
  const [asrEnablePunc, setAsrEnablePunc] = useState(true);
  const [asrModelName, setAsrModelName] = useState("");
  const [aliyunAsrCustomizationId, setAliyunAsrCustomizationId] = useState("");
  const [aliyunAsrVocabularyId, setAliyunAsrVocabularyId] = useState("");
  const [aliyunAsrEnableItn, setAliyunAsrEnableItn] = useState(true);
  const [aliyunAsrEnablePunc, setAliyunAsrEnablePunc] = useState(true);
  const [aliyunAsrEnableDisfluency, setAliyunAsrEnableDisfluency] = useState(false);
  const [aliyunAsrEnableIntermediate, setAliyunAsrEnableIntermediate] = useState(true);
  const [aliyunAsrEnableSemanticBreak, setAliyunAsrEnableSemanticBreak] = useState(false);
  const [aliyunAsrMaxSentenceSilence, setAliyunAsrMaxSentenceSilence] = useState(800);
  const [aliyunAsrEnableVoiceDetection, setAliyunAsrEnableVoiceDetection] = useState(false);
  const [aliyunAsrMaxStartSilence, setAliyunAsrMaxStartSilence] = useState<number | "">("");
  const [aliyunAsrMaxEndSilence, setAliyunAsrMaxEndSilence] = useState<number | "">("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedVoice = useMemo(() => findCosyVoiceVoice(aliyunVoice), [aliyunVoice]);
  const selectedAsrModel = useMemo(
    () => ALIYUN_NLS_ASR_MODELS.find((model) => model.id === asrModelName),
    [asrModelName]
  );

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
    if (data.ttsVolume != null) setTtsVolume(data.ttsVolume);
    if (data.ttsSpeechRate != null) setTtsSpeechRate(data.ttsSpeechRate);
    if (data.ttsPitchRate != null) setTtsPitchRate(data.ttsPitchRate);
    if (data.ttsSampleRate != null) setTtsSampleRate(data.ttsSampleRate);
    setAsrEnableItn(data.asrEnableItn !== false);
    setAsrEnablePunc(data.asrEnablePunc !== false);
    setAsrModelName(data.asrModelName || "");
    setAliyunAsrCustomizationId(data.aliyunAsrCustomizationId || "");
    setAliyunAsrVocabularyId(data.aliyunAsrVocabularyId || "");
    setAliyunAsrEnableItn(data.aliyunAsrEnableItn !== false);
    setAliyunAsrEnablePunc(data.aliyunAsrEnablePunc !== false);
    setAliyunAsrEnableDisfluency(data.aliyunAsrEnableDisfluency === true);
    setAliyunAsrEnableIntermediate(data.aliyunAsrEnableIntermediate !== false);
    setAliyunAsrEnableSemanticBreak(data.aliyunAsrEnableSemanticBreak === true);
    if (data.aliyunAsrMaxSentenceSilence != null) setAliyunAsrMaxSentenceSilence(data.aliyunAsrMaxSentenceSilence);
    setAliyunAsrEnableVoiceDetection(data.aliyunAsrEnableVoiceDetection === true);
    setAliyunAsrMaxStartSilence(data.aliyunAsrMaxStartSilence ?? "");
    setAliyunAsrMaxEndSilence(data.aliyunAsrMaxEndSilence ?? "");
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

  function optionalInt(value: number | "") {
    return value === "" ? undefined : value;
  }

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
      ttsVolume: optionalInt(ttsVolume),
      ttsSpeechRate: optionalInt(ttsSpeechRate),
      ttsPitchRate: optionalInt(ttsPitchRate),
      ttsSampleRate: optionalInt(ttsSampleRate),
      asrEnableItn,
      asrEnablePunc,
      asrModelName,
      aliyunAsrCustomizationId,
      aliyunAsrVocabularyId,
      aliyunAsrEnableItn,
      aliyunAsrEnablePunc,
      aliyunAsrEnableDisfluency,
      aliyunAsrEnableIntermediate,
      aliyunAsrEnableSemanticBreak,
      aliyunAsrMaxSentenceSilence,
      aliyunAsrEnableVoiceDetection,
      aliyunAsrMaxStartSilence: optionalInt(aliyunAsrMaxStartSilence),
      aliyunAsrMaxEndSilence: optionalInt(aliyunAsrMaxEndSilence),
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

  const agentReady = Boolean(config?.agentConsumer && config.aliyunAvailable);
  const currentLabel = activeProvider === "aliyun"
    ? config?.aliyunAvailable ? "客户端线路 · 阿里云已连通" : "客户端线路 · 阿里云未就绪"
    : config?.volcengineAvailable ? "客户端线路 · 豆包已连通" : "客户端线路 · 豆包未就绪";

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      <form onSubmit={save} autoComplete="off">
        <section className="card">
          <div className="card-head">
            <h2>LiveKit Agent 语音摘要</h2>
            <ConfigStatus
              ready={agentReady}
              readyText="Agent 消费端 · 阿里云 NLS 已连通"
              waitText="Agent 消费端尚未就绪"
            />
          </div>
          <p className="muted">
            LiveKit Agent 从本页读取阿里云 NLS 凭据与 ASR 参数；Windows 客户端仍使用下方「当前线路」选择豆包或阿里云。
          </p>
          <div className="status-grid">
            <div className={`status-chip ${config?.agentConsumer ? "ready" : ""}`}>
              <strong>Agent 消费</strong>
              <span>{config?.agentConsumer ? "已启用 speech_configs" : "未启用"}</span>
            </div>
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
            客户端当前线路
            <select
              value={activeProvider}
              onChange={(event) => setActiveProvider(event.target.value as SpeechProvider)}
            >
              <option value="aliyun">阿里云智能语音</option>
              <option value="volcengine">豆包语音（声音复刻）</option>
            </select>
          </label>
          <p className="muted">{currentLabel}</p>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>音色目录与预览</h2>
            <ConfigStatus
              ready={Boolean(config?.aliyunAvailable)}
              readyText="可合成预览"
              waitText="需先配置阿里云凭据"
            />
          </div>
          <p className="muted">CosyVoice / NLS 官方预置音色。复刻音色（cosyvoice-*）由客户端录音自动分配，不在此列表。</p>
          <label>
            音色 ID
            <input
              list="cosyvoice-voices"
              value={aliyunVoice}
              onChange={(event) => setAliyunVoice(event.target.value)}
            />
          </label>
          <datalist id="cosyvoice-voices">
            {COSYVOICE_VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>{voice.name}</option>
            ))}
          </datalist>
          {selectedVoice ? (
            <p className="muted">
              {selectedVoice.name} · {selectedVoice.language} · {selectedVoice.gender === "male" ? "男声" : selectedVoice.gender === "female" ? "女声" : selectedVoice.gender === "child" ? "童声" : "中性"}
            </p>
          ) : (
            <p className="muted">自定义音色 ID：{aliyunVoice || "未填写"}</p>
          )}
          <div className="row">
            <button className="secondary" type="button" disabled={busy} onClick={() => void test("aliyun")}>
              预览合成（{PREVIEW_TEXT.slice(0, 8)}…）
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>TTS 参数</h2>
            <ConfigStatus ready={Boolean(config?.ttsAvailable)} readyText="TTS 可用" waitText="TTS 未就绪" />
          </div>
          <p className="muted">阿里云 NLS / CosyVoice 合成参数，Agent 与客户端合成共用。</p>
          <div className="row">
            <label>
              音量（0–100）
              <input
                type="number"
                min={0}
                max={100}
                value={ttsVolume}
                onChange={(event) => setTtsVolume(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
            <label>
              语速（-500–500）
              <input
                type="number"
                min={-500}
                max={500}
                value={ttsSpeechRate}
                onChange={(event) => setTtsSpeechRate(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
            <label>
              音调（-500–500）
              <input
                type="number"
                min={-500}
                max={500}
                value={ttsPitchRate}
                onChange={(event) => setTtsPitchRate(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
            <label>
              采样率（Hz）
              <input
                type="number"
                min={8000}
                max={48000}
                step={1000}
                value={ttsSampleRate}
                onChange={(event) => setTtsSampleRate(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>LiveKit Agent ASR 参数</h2>
            <ConfigStatus ready={Boolean(config?.asrAvailable)} readyText="ASR 可用" waitText="ASR 未就绪" />
          </div>
          <p className="muted">实时字幕由 LiveKit Agent 消费；以下为阿里云 NLS SpeechTranscriber 参数。</p>
          <label>
            ASR 模型参考
            <select value={asrModelName} onChange={(event) => setAsrModelName(event.target.value)}>
              {ALIYUN_NLS_ASR_MODELS.map((model) => (
                <option key={model.id || "default"} value={model.id}>{model.name}</option>
              ))}
            </select>
          </label>
          {selectedAsrModel?.notes ? <p className="muted">{selectedAsrModel.notes}</p> : null}
          <div className="row">
            <label>
              全局 ITN
              <select value={asrEnableItn ? "yes" : "no"} onChange={(event) => setAsrEnableItn(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              全局标点
              <select value={asrEnablePunc ? "yes" : "no"} onChange={(event) => setAsrEnablePunc(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
          </div>
          <label>
            定制模型 ID（CustomizationId）
            <input value={aliyunAsrCustomizationId} onChange={(event) => setAliyunAsrCustomizationId(event.target.value)} />
          </label>
          <label>
            热词表 ID（VocabularyId）
            <input value={aliyunAsrVocabularyId} onChange={(event) => setAliyunAsrVocabularyId(event.target.value)} />
          </label>
          <div className="row">
            <label>
              ITN
              <select value={aliyunAsrEnableItn ? "yes" : "no"} onChange={(event) => setAliyunAsrEnableItn(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              标点
              <select value={aliyunAsrEnablePunc ? "yes" : "no"} onChange={(event) => setAliyunAsrEnablePunc(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              语气词过滤
              <select value={aliyunAsrEnableDisfluency ? "yes" : "no"} onChange={(event) => setAliyunAsrEnableDisfluency(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              中间结果
              <select value={aliyunAsrEnableIntermediate ? "yes" : "no"} onChange={(event) => setAliyunAsrEnableIntermediate(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              语义断句
              <select value={aliyunAsrEnableSemanticBreak ? "yes" : "no"} onChange={(event) => setAliyunAsrEnableSemanticBreak(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              语音检测
              <select value={aliyunAsrEnableVoiceDetection ? "yes" : "no"} onChange={(event) => setAliyunAsrEnableVoiceDetection(event.target.value === "yes")}>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              句间静音（ms）
              <input
                type="number"
                min={200}
                max={6000}
                value={aliyunAsrMaxSentenceSilence}
                onChange={(event) => setAliyunAsrMaxSentenceSilence(Number(event.target.value))}
              />
            </label>
            <label>
              起始静音（ms，可选）
              <input
                type="number"
                min={0}
                value={aliyunAsrMaxStartSilence}
                onChange={(event) => setAliyunAsrMaxStartSilence(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
            <label>
              结束静音（ms，可选）
              <input
                type="number"
                min={0}
                value={aliyunAsrMaxEndSilence}
                onChange={(event) => setAliyunAsrMaxEndSilence(event.target.value === "" ? "" : Number(event.target.value))}
              />
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>阿里云凭据</h2>
            <ConfigStatus
              ready={Boolean(config?.aliyunAvailable)}
              readyText="已连通"
              waitText="未连通"
            />
          </div>
          <p className="muted">Appkey 来自智能语音交互控制台项目；AccessKey 用于 CreateToken。Agent 与客户端阿里云线路共用。</p>
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
          <label>
            网关
            <input value={aliyunGateway} onChange={(event) => setAliyunGateway(event.target.value)} />
          </label>
          <label>
            启用阿里云
            <select value={aliyunEnabled ? "yes" : "no"} onChange={(event) => setAliyunEnabled(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">停用</option>
            </select>
          </label>
          <div className="row">
            <button className="secondary" type="button" disabled={busy} onClick={() => void test("aliyun")}>
              测试阿里云
            </button>
          </div>
        </section>

        <details className="card config-details">
          <summary>
            <span>豆包语音（客户端声音复刻）</span>
            <ConfigStatus
              ready={Boolean(config?.volcengineAvailable)}
              readyText={config?.ttsAvailable ? "已连通 · 可复刻" : "鉴权可用"}
              waitText="未连通"
            />
          </summary>
          <div className="stack">
            <p className="muted">录音和声音刻录在助手本机完成。管理网页不采集麦克风。</p>
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
                <input list="volcengine-tts-resources" value={ttsResourceId} onChange={(event) => setTtsResourceId(event.target.value)} />
              </label>
              <datalist id="volcengine-tts-resources">
                {VOLCENGINE_TTS_RESOURCES.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </datalist>
              <label>
                ASR Resource
                <input list="volcengine-asr-resources" value={asrResourceId} onChange={(event) => setAsrResourceId(event.target.value)} />
              </label>
              <datalist id="volcengine-asr-resources">
                {VOLCENGINE_ASR_RESOURCES.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </datalist>
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
