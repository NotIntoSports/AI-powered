"use client";

import { useEffect, useMemo, useState } from "react";
import { displayError, parseAPIError, requestJSON, type CatalogEntry, type VoiceRoute } from "../../../lib/control-api";

type Draft = Omit<VoiceRoute, "id" | "active" | "ready" | "status" | "configVersion" | "updatedAt">;
const emptyDraft: Draft = { name: "", mode: "cascaded", asrProviderId: "", asrModelId: "", llmProviderId: "", llmModelId: "", ttsProviderId: "", ttsModelId: "", voiceId: "", e2eProviderId: "", e2eModelId: "" };

function refValue(providerId: string, modelId: string) { return providerId && modelId ? `${providerId}::${modelId}` : ""; }
function parseRef(value: string) { const at = value.indexOf("::"); return at > 0 ? { providerId: value.slice(0, at), modelId: value.slice(at + 2) } : { providerId: "", modelId: "" }; }
function pipelineLabel(route: VoiceRoute) {
  return route.mode === "e2e" ? `端到端 · ${route.e2eModelId}` : `级联 · ${route.asrModelId} → ${route.llmModelId} → ${route.ttsModelId}`;
}

export function VoiceRoutesPanel() {
  const [routes, setRoutes] = useState<VoiceRoute[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [routeResult, catalogResult] = await Promise.all([
      requestJSON("/api/v1/admin/settings/voice-routes"),
      requestJSON("/api/v1/admin/settings/catalog")
    ]);
    if (!routeResult.response.ok) { setError(displayError(parseAPIError(routeResult.body, "无法读取语音线路"))); return; }
    setRoutes(routeResult.body as VoiceRoute[]);
    if (catalogResult.response.ok) setCatalog((catalogResult.body as CatalogEntry[]).filter((model) => model.enabled && model.runtimeVerified));
  }
  useEffect(() => { void load(); }, []);

  const options = useMemo(() => {
    const by = (capability: string) => catalog.filter((model) => model.capability === capability);
    return { asr: by("asr"), llm: by("llm"), tts: by("tts"), e2e: by("e2e") };
  }, [catalog]);
  const voiceProviderId = draft.mode === "e2e" ? draft.e2eProviderId : draft.ttsProviderId;
  const selectedVoiceModelId = draft.mode === "e2e" ? draft.e2eModelId : draft.ttsModelId;
  const voiceOptions = useMemo(() => catalog.filter((model) =>
    model.enabled && model.capability === "tts" && model.providerId === voiceProviderId && model.modelId !== selectedVoiceModelId
  ), [catalog, selectedVoiceModelId, voiceProviderId]);
  const setRef = (kind: "asr" | "llm" | "tts" | "e2e", value: string) => {
    const ref = parseRef(value);
    setDraft((current) => ({ ...current, [`${kind}ProviderId`]: ref.providerId, [`${kind}ModelId`]: ref.modelId }));
  };
  const select = (label: string, kind: "asr" | "llm" | "tts" | "e2e", models: CatalogEntry[]) => (
    <label>{label}<select value={refValue(draft[`${kind}ProviderId`], draft[`${kind}ModelId`])} onChange={(event) => setRef(kind, event.target.value)} required>
      <option value="">请选择已启用模型</option>{models.map((model) => <option key={`${model.providerId}:${model.modelId}`} value={refValue(model.providerId, model.modelId)}>{model.label}</option>)}
    </select></label>
  );

  function edit(route?: VoiceRoute, copy = false) {
    setEditingId(route && !copy ? route.id : "new");
    setDraft(route ? { name: copy ? `${route.name} 副本` : route.name, mode: route.mode, asrProviderId: route.asrProviderId, asrModelId: route.asrModelId, llmProviderId: route.llmProviderId, llmModelId: route.llmModelId, ttsProviderId: route.ttsProviderId, ttsModelId: route.ttsModelId, voiceId: route.voiceId, e2eProviderId: route.e2eProviderId, e2eModelId: route.e2eModelId } : emptyDraft);
    setError(""); setNotice("");
  }

  async function save() {
    const id = editingId || "new"; setBusy(id); setError("");
    try {
      const result = await requestJSON(id === "new" ? "/api/v1/admin/settings/voice-routes" : `/api/v1/admin/settings/voice-routes/${id}`, { method: id === "new" ? "POST" : "PUT", body: JSON.stringify(draft) });
      if (!result.response.ok) { setError(displayError(parseAPIError(result.body, "保存线路失败"))); return; }
      setEditingId(null); setNotice("语音线路已保存。"); await load();
    } finally { setBusy(""); }
  }
  async function action(route: VoiceRoute, operation: "activate" | "test" | "delete") {
    setBusy(`${operation}:${route.id}`); setError(""); setNotice("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/voice-routes/${route.id}${operation === "delete" ? "" : `/${operation}`}`, { method: operation === "delete" ? "DELETE" : "POST" });
      if (!result.response.ok) { setError(displayError(parseAPIError(result.body, "线路操作失败"))); return; }
      setNotice(operation === "activate" ? "已启用该线路，新会话将使用此配置。" : operation === "test" ? "线路配置校验通过。" : "线路已删除。"); await load();
    } finally { setBusy(""); }
  }

  const active = routes.find((route) => route.active);

  return <section className="card stack">
    <div className="card-head"><div><h2>语音线路管理</h2><p className="muted">会议走哪条链路只在这里点「启用」；同一时间只能启用一条。LiveKit Agent 每个新会话读取当前启用线路，进行中的会话不热切。下方凭据区只填 Key，不会切换线路。</p></div><button type="button" onClick={() => edit()}>新建线路</button></div>
    {error ? <p className="error">{error}</p> : null}{notice ? <p className="ok">{notice}</p> : null}
    {active ? <div className="status-chip ready"><strong>当前会议使用</strong><span>{active.name} · {pipelineLabel(active)}</span></div> : <p className="error">尚未启用任何线路，Agent 无法开会。</p>}
    {editingId ? <div className="config-fieldset stack">
      <label>线路名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={100} /></label>
      <label>线路模式<select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as "cascaded" | "e2e" })}><option value="cascaded">级联 ASR + LLM + TTS</option><option value="e2e">端到端 Realtime</option></select></label>
      {draft.mode === "e2e" ? (
        <>
          {select("Realtime / E2E 模型", "e2e", options.e2e)}
          {options.e2e.length === 0 ? <p className="muted">没有可选项。请到「模型管理」启用官方 Realtime 模型（例如 qwen-audio-3.0-realtime-plus）。Realtime / ASR / TTS 不必做 Chat Completions 本人实测，启用后即可出现在此列表。</p> : null}
        </>
      ) : <>{select("ASR", "asr", options.asr)}{select("LLM", "llm", options.llm)}{select("TTS", "tts", options.tts)}</>}
      <label>音色<select value={draft.voiceId} onChange={(event) => setDraft({ ...draft, voiceId: event.target.value })}>
        <option value="">使用模型默认音色</option>
        {draft.voiceId && !voiceOptions.some((voice) => voice.modelId === draft.voiceId) ? <option value={draft.voiceId}>{draft.voiceId}（当前保存）</option> : null}
        {voiceOptions.map((voice) => <option key={`${voice.providerId}:${voice.modelId}`} value={voice.modelId}>{voice.label}</option>)}
      </select></label>
      <div className="row"><button type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy ? "保存中…" : "保存线路"}</button><button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => setEditingId(null)}>取消</button></div>
    </div> : null}
    <div className="stack">{routes.length === 0 ? <p className="muted">还没有语音线路。</p> : routes.map((route) => <div className="status-chip" key={route.id}>
      <div className="card-head"><div><strong>{route.name}</strong><span>{pipelineLabel(route)}</span></div><span className={route.active ? "online" : route.ready ? "muted" : "error"}>{route.active ? "当前启用" : route.ready ? "可启用" : "模型未就绪"}</span></div>
      <div className="row"><button className="secondary" type="button" onClick={() => edit(route)}>编辑</button><button className="secondary" type="button" onClick={() => edit(route, true)}>复制</button><button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void action(route, "test")}>测试</button>{!route.active ? <><button type="button" disabled={!route.ready || Boolean(busy)} onClick={() => void action(route, "activate")}>启用</button><button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void action(route, "delete")}>删除</button></> : null}</div>
    </div>)}</div>
  </section>;
}
