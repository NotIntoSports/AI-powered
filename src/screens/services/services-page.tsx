import { FormEvent, useCallback, useEffect, useState } from "react";
import * as api from "../../api/commands";
import { EmbeddingEditor } from "../../features/services/embedding-editor";
import { LiveKitEditor } from "../../features/services/livekit-editor";
import type { CommandResult, PublicConfig, VoiceRouteMode } from "../../generated/bindings";

const optional = (value: string) => value.trim() || null;
const errorText = (error: { code: string; message: string; field?: string | null }) => `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;
const initialRoute = { id: "", name: "", mode: "cascaded" as VoiceRouteMode, asrProviderId: "", asrModelId: "", llmProviderId: "", llmModelId: "", ttsProviderId: "", ttsModelId: "", voiceId: "", e2eProviderId: "", e2eModelId: "" };

export function ServicesPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [message, setMessage] = useState("正在读取本地配置…");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [provider, setProvider] = useState({ id: "", name: "", baseUrl: "", apiKey: "" });
  const [route, setRoute] = useState(initialRoute);

  const reload = useCallback(async () => {
    try {
      const result = await api.getConfigPublic();
      if (result.ok) { setConfig(result.data); setMessage(""); }
      else setMessage(errorText(result.error));
    } catch {
      setMessage("IPC_UNAVAILABLE：无法读取本地配置");
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function run(action: () => Promise<CommandResult<unknown>>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      await reload();
      if (!result.ok) { setMessage(errorText(result.error)); return false; }
      setMessage(success);
      return true;
    } catch {
      await reload();
      setMessage("IPC_UNAVAILABLE：本地操作失败");
      return false;
    } finally { setBusy(false); }
  }

  async function submitProvider(event: FormEvent) {
    event.preventDefault();
    try {
      await run(() => api.saveModelProvider({ id: provider.id.trim(), name: optional(provider.name), baseUrl: provider.baseUrl.trim(), apiKey: optional(provider.apiKey) }), "供应商已保存");
    } finally {
      setProvider((current) => ({ ...current, apiKey: "" }));
    }
  }

  async function discover(id: string) {
    setBusy(true);
    try {
      const result = await api.discoverModelProvider(id);
      if (result.ok) {
        setModels((current) => ({ ...current, [id]: result.data.models.map((model) => model.id) }));
        setMessage("已发现 " + result.data.models.length + " 个模型");
      } else setMessage(errorText(result.error));
    } catch {
      setMessage("IPC_UNAVAILABLE：模型发现失败");
    } finally { setBusy(false); }
  }

  async function submitRoute(event: FormEvent) {
    event.preventDefault();
    const cascaded = route.mode === "cascaded";
    await run(() => api.saveSpeechRoute({
      id: route.id.trim(), name: route.name.trim(), mode: route.mode,
      asrProviderId: cascaded ? optional(route.asrProviderId) : null,
      asrModelId: cascaded ? optional(route.asrModelId) : null,
      llmProviderId: cascaded ? optional(route.llmProviderId) : null,
      llmModelId: cascaded ? optional(route.llmModelId) : null,
      ttsProviderId: cascaded ? optional(route.ttsProviderId) : null,
      ttsModelId: cascaded ? optional(route.ttsModelId) : null,
      voiceId: optional(route.voiceId),
      e2eProviderId: cascaded ? null : optional(route.e2eProviderId),
      e2eModelId: cascaded ? null : optional(route.e2eModelId),
    }), "语音线路已保存，请先测试再启用");
  }

  const providers = config?.models.providers ?? [];
  const setRouteField = (key: keyof typeof route, value: string) => setRoute((current) => ({ ...current, [key]: value }));

  return <section className="services-page" aria-labelledby="page-heading-services">
    <p className="page-eyebrow">本机配置</p><h1 id="page-heading-services">服务</h1>
    <p className="services-intro">非敏感配置保存在本机；密钥仅保存到 Windows 凭据管理器。</p>
    {message && <p className="services-message" role="status">{message}</p>}
    <div className="services-grid">
      <section className="service-panel">
        <h2>模型供应商</h2>
        <form className="service-form" onSubmit={submitProvider}>
          <label>供应商 ID<input required pattern="[a-z0-9_-]+" value={provider.id} onChange={(e) => setProvider({ ...provider, id: e.target.value })}/></label>
          <label>显示名称<input value={provider.name} onChange={(e) => setProvider({ ...provider, name: e.target.value })}/></label>
          <label>接口基址<input required type="url" placeholder="https://example.com/v1" value={provider.baseUrl} onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })}/></label>
          <label>API Key<input type="password" autoComplete="new-password" value={provider.apiKey} onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}/><small>留空会保留已保存的密钥</small></label>
          <button disabled={busy} type="submit">保存供应商</button>
        </form>
        <div className="service-list">
          {providers.length === 0 && <p>还没有供应商。</p>}
          {providers.map((item) => <article className="service-card" key={item.id}>
            <h3>{item.name || item.id}</h3><p>{item.baseUrl}</p>
            <p>密钥：{item.credential?.configured ? "已安全保存" : "未配置"}</p>
            {config?.models.activeProviderId === item.id && <strong>当前默认</strong>}
            <div className="service-actions">
              <button aria-label={"编辑 " + (item.name || item.id)} disabled={busy} onClick={() => setProvider({ id: item.id, name: item.name ?? "", baseUrl: item.baseUrl, apiKey: "" })}>编辑</button>
              <button disabled={busy} onClick={() => void run(() => api.testModelProvider(item.id), "连接测试通过")}>测试</button>
              <button disabled={busy} onClick={() => void discover(item.id)}>发现模型</button>
              <button disabled={busy} onClick={() => void run(() => api.activateModelProvider(item.id), "默认供应商已更新")}>设为默认</button>
              <button disabled={busy} onClick={() => void run(() => api.deleteModelProvider(item.id), "供应商已删除")}>删除</button>
            </div>
            {models[item.id]?.length > 0 && <p>模型：{models[item.id].join("、")}</p>}
          </article>)}
        </div>
      </section>
      <section className="service-panel">
        <h2>语音线路</h2>
        <form className="service-form" onSubmit={submitRoute}>
          <label>线路 ID<input required pattern="[a-z0-9_-]+" value={route.id} onChange={(e) => setRouteField("id", e.target.value)}/></label>
          <label>线路名称<input required value={route.name} onChange={(e) => setRouteField("name", e.target.value)}/></label>
          <label>模式<select value={route.mode} onChange={(e) => setRouteField("mode", e.target.value)}><option value="cascaded">级联 ASR → LLM → TTS</option><option value="e2e">端到端 Realtime</option></select></label>
          {route.mode === "cascaded" ? <>
            <ProviderModelFields prefix="ASR" providers={providers} provider={route.asrProviderId} model={route.asrModelId} modelChoices={models[route.asrProviderId] ?? []} onProvider={(v) => setRouteField("asrProviderId", v)} onModel={(v) => setRouteField("asrModelId", v)}/>
            <ProviderModelFields prefix="LLM" providers={providers} provider={route.llmProviderId} model={route.llmModelId} modelChoices={models[route.llmProviderId] ?? []} onProvider={(v) => setRouteField("llmProviderId", v)} onModel={(v) => setRouteField("llmModelId", v)}/>
            <ProviderModelFields prefix="TTS" providers={providers} provider={route.ttsProviderId} model={route.ttsModelId} modelChoices={models[route.ttsProviderId] ?? []} onProvider={(v) => setRouteField("ttsProviderId", v)} onModel={(v) => setRouteField("ttsModelId", v)}/>
          </> : <ProviderModelFields prefix="Realtime" providers={providers} provider={route.e2eProviderId} model={route.e2eModelId} modelChoices={models[route.e2eProviderId] ?? []} onProvider={(v) => setRouteField("e2eProviderId", v)} onModel={(v) => setRouteField("e2eModelId", v)}/>}
          <label>音色 ID（可选）<input value={route.voiceId} onChange={(e) => setRouteField("voiceId", e.target.value)}/></label>
          <button disabled={busy || providers.length === 0} type="submit">保存语音线路</button>
        </form>
        <div className="service-list">
          {(config?.speech.voiceRoutes ?? []).length === 0 && <p>还没有语音线路。</p>}
          {config?.speech.voiceRoutes.map((item) => <article className="service-card" key={item.id}>
            <h3>{item.name}</h3><p>{item.mode === "cascaded" ? "级联" : "端到端"} · {item.ready ? "测试通过" : "尚未就绪"}</p>
            {item.active && <strong>当前启用</strong>}
            <div className="service-actions">
              <button aria-label={"编辑 " + item.name} disabled={busy} onClick={() => setRoute({
                id: item.id, name: item.name, mode: item.mode,
                asrProviderId: item.asrProviderId ?? "", asrModelId: item.asrModelId ?? "",
                llmProviderId: item.llmProviderId ?? "", llmModelId: item.llmModelId ?? "",
                ttsProviderId: item.ttsProviderId ?? "", ttsModelId: item.ttsModelId ?? "",
                voiceId: item.voiceId ?? "", e2eProviderId: item.e2eProviderId ?? "",
                e2eModelId: item.e2eModelId ?? "",
              })}>编辑</button>
              <button disabled={busy} onClick={() => void run(() => api.testSpeechRoute(item.id), "线路测试通过")}>测试</button>
              <button disabled={busy || !item.ready} onClick={() => void run(() => api.activateSpeechRoute(item.id), "语音线路已启用")}>启用</button>
              <button disabled={busy} onClick={() => void run(() => api.deleteSpeechRoute(item.id), "语音线路已删除")}>删除</button>
            </div>
          </article>)}
        </div>
      </section>
    </div>
    <EmbeddingEditor />
    <LiveKitEditor />
  </section>;
}

function ProviderModelFields(props: { prefix: string; providers: PublicConfig["models"]["providers"]; provider: string; model: string; modelChoices: string[]; onProvider: (value: string) => void; onModel: (value: string) => void }) {
  const listId = `models-${props.prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <div className="provider-model-fields">
    <label>{props.prefix} 供应商<select required value={props.provider} onChange={(e) => props.onProvider(e.target.value)}><option value="">请选择</option>{props.providers.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>
    <label>{props.prefix} 模型<input required list={listId} value={props.model} onChange={(e) => props.onModel(e.target.value)}/><datalist id={listId}>{props.modelChoices.map((model) => <option key={model} value={model}/>)}</datalist></label>
  </div>;
}
